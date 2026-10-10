// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;   // pinned for reproducible deployed bytecode (audit I-4)

/*//////////////////////////////////////////////////////////////////////////////
  A8 之路 — SacrificeMinter (REFERENCE IMPLEMENTATION, UNAUDITED)

  一笔交易里铸多个,绕过每钱包上限:工厂在一笔交易内部署 N 个一次性 Minter 合约,
  每个是一个独立的 msg.sender,各自领一份 per-wallet 额度,铸到的 NFT 直接转给下单的
  那个钱包。连接的钱包付全部 gas 和全部 mint 费用。原理与风险见 SKILL.md。

  ──────────────────────────────────────────────────────────────────────────────
  安全模型:为什么这个合约「偷不走你的钱」—— 这是设计出来的,不是承诺出来的。

  1. 非托管、不需要授权(approve)。你只是发一笔带 value 的交易;你从不把任何代币或 NFT
     的授权交给本合约。所以本合约能动用的,**上限就是你这一笔交易里发进来的 value**,它
     够不到你钱包里的其它任何东西。这是最硬的一条:没有 approve,就没有「盗刷」。
  2. 没有 owner / admin / 升级 / selfdestruct。没有任何特权函数。没人(包括部署者)能暂停它、
     改它、或从它里面取钱。合约部署后就是定死的,你可以在区块浏览器上逐行读。
  3. 收款人永远是「下单的那个钱包」(batchMint 的 msg.sender),**硬编码,不是参数**。我们没有
     任何办法把 NFT 或退款指到别的地址 —— 代码里根本没有这个参数。
  4. 花剩下的 ETH 全额退回给你(msg.sender),在同一笔交易里。合约结束时余额为 0,留不住钱。
  5. 失败即全额回滚(fail-safe)。任何一个 Minter 没能把 NFT 如数转给你,整笔交易 revert ——
     你不会出现「付了钱、NFT 却卡在合约里」的情况。宁可整单失败,也不让资产卡住。
  6. mint 目标合约由**你的前端传入**,不是我们预埋的地址。你铸的是你选的那个盘。

  ──────────────────────────────────────────────────────────────────────────────
  免责声明(DISCLAIMER)

  本合约按「现状」提供,不作任何明示或默示担保。使用它来绕过某个项目设置的每钱包上限,是否
  被该项目或平台视为违规、是否触犯其条款,由使用者自行判断并承担全部后果。链上交易不可逆;
  mint 可能因售罄、未开售、白名单、价格变动等原因失败,gas 不退。作者与 a8journey 不托管你的
  任何资产、不代持私钥、不经手你的资金,因而无法、也不会动用你的钱 —— 本合约的所有行为都在
  链上公开可查。使用即表示你已阅读 SKILL.md 与 README.md 并理解上述风险。

  状态(2026-10):已用官方 solc 0.8.26(optimizer 200, evmVersion paris)编译;
  Sepolia 两轮端到端验证(每钱包限 1 的测试盘 ×5、真 SeaDrop 单例公售 ×4,NFT 全部归集回调用者);
  一次对抗性 AI 审计(无盗取路径;修复 H-1 退款锁死、M-1 非标 transferFrom),修复后复测通过。
  ⚠️ 仍未经专业审计公司审计。主网使用风险自担,先小额。
//////////////////////////////////////////////////////////////////////////////*/

interface IERC721Like {
    function balanceOf(address owner) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
    function totalSupply() external view returns (uint256);
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/// @notice 一次性铸造合约。全部动作在构造函数里完成,不部署 runtime code。
/// @dev    每个实例是一个独立的 msg.sender → 独立的 per-wallet 额度。构造期 extcodesize=0,
///         所以 _safeMint 把它当 EOA(跳过回调),也顺带绕过 extcodesize/isContract 反合约检查。
contract Minter {
    constructor(
        address drop,          // mint 目标合约(用户前端传入)
        bytes memory mintData, // mint 的 calldata(通常是 mint(qty) 或 SeaDrop mintPublic)
        uint256 value,         // 这一个 Minter 要花的 mint 费
        address nft,           // NFT 合约(铸出来的 token 在这里;常与 drop 相同)
        address recipient      // 收款人 = 工厂的调用者,工厂硬编码传入,Minter 不自己决定
    ) payable {
        uint256 before = _supply(nft);

        // 1. 以「本 Minter 自己」为 minter 去铸 —— 独立地址,独立额度。
        (bool ok, ) = drop.call{value: value}(mintData);
        require(ok, "mint call failed");

        // 2. 把这一次铸到的 NFT 全部转回收款人。
        //    采用 totalSupply 区间 + ownerOf 核对(覆盖 ERC721A / SeaDrop 这类顺序发号的主流盘)。
        //    单笔交易内 EVM 单线程,between mint and sweep 不可能有别人插队,所以区间就是我们铸的。
        uint256 afterS = _supply(nft);
        uint256 moved;
        uint256 want = IERC721Like(nft).balanceOf(address(this));
        // 从 before 到 afterS **闭区间**逐个认领属于自己的 token。
        // 为什么是 `id <= afterS` 而不是 `< afterS`:ERC721A 可以 start-at-0 或 start-at-1。
        //   start-at-0:铸 1 个后 totalSupply=1,新 id=0,区间要含 before;
        //   start-at-1:铸 1 个后 totalSupply=1,新 id=1,区间要含 afterS。
        // 用闭区间 + ownerOf 核对同时覆盖两种;多扫的那一个端点若不属于自己会被 ownerOf 跳过。
        // 单笔交易 EVM 单线程,本 Minter mint 与 sweep 之间无人插队,所以 [before,afterS] 就是它铸的。
        for (uint256 id = before; id <= afterS && moved < want; id++) {
            if (_ownerIs(nft, id, address(this))) {
                IERC721Like(nft).transferFrom(address(this), recipient, id);
                // M-1: do NOT trust a non-reverting transferFrom — a non-compliant
                // nft could no-op and leave the token here. Re-read ownership; a
                // silent no-op then fails `moved == want` and reverts the whole tx.
                require(_ownerIs(nft, id, recipient), "transfer no-op");
                moved++;
            }
        }

        // 3. fail-safe:没能把全部铸到的 NFT 转出去,就整笔回滚 —— 绝不留 NFT 卡在本合约。
        require(moved == want && want > 0, "sweep incomplete");

        // 4. H-1: a drop can refund overpayment to msg.sender (= this Minter), and
        //    this Minter ends with NO runtime code, so any ETH left here would be
        //    locked forever — unreachable by everyone (self-loss, not theft, but a
        //    loss). Forward the residue to the recipient so "leftover fully
        //    refunded" holds end to end, not just at the factory level.
        uint256 dust = address(this).balance;
        if (dust > 0) {
            (bool r, ) = payable(recipient).call{value: dust}("");
            require(r, "minter refund failed");
        }
        // 构造函数结束,不部署 runtime code,不 selfdestruct。
    }

    function _supply(address nft) private view returns (uint256) {
        // totalSupply 不是所有合约都有;读不到就返回 0,让 sweep 落到 ownerOf 核对上。
        (bool ok, bytes memory d) = nft.staticcall(abi.encodeWithSignature("totalSupply()"));
        return (ok && d.length >= 32) ? abi.decode(d, (uint256)) : 0;
    }

    function _ownerIs(address nft, uint256 id, address who) private view returns (bool) {
        (bool ok, bytes memory d) = nft.staticcall(abi.encodeWithSignature("ownerOf(uint256)", id));
        return ok && d.length >= 32 && abi.decode(d, (address)) == who;
    }
}

contract SacrificeMinter {
    // 极简重入锁。本合约不持久化任何余额/授权,但部署的 Minter 会 call 不可信的 drop 合约,
    // 加锁是零成本的保守选择。
    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }

    event Batch(address indexed user, address indexed drop, uint256 n, uint256 minted, uint256 spent);

    /// @notice 一笔交易铸 N 份。调用者(msg.sender)付全部 gas + 全部 mint 费,NFT 全部回到调用者。
    /// @param drop     mint 目标合约
    /// @param mintData 每个 Minter 执行的 mint calldata
    /// @param perMint  每个 Minter 的 mint 费(wei)
    /// @param nft      NFT 合约地址(铸出来的 token 所在;多数情况下 == drop)
    /// @param n        份数
    function batchMint(address drop, bytes calldata mintData, uint256 perMint, address nft, uint256 n)
        external
        payable
        nonReentrant
    {
        // Hard on-chain backstop of 100. The APP-level default (cfg.batchMaxN = 20)
        // is the real per-tx cap the service/frontend enforces; this 100 only stops
        // a pathological call. A large N on a low-gas L2 simply reverts (safe). (L-3)
        require(n > 0 && n <= 100, "n out of range");
        require(msg.value >= perMint * n, "insufficient value");
        address user = msg.sender;                             // 收款人硬编码 = 调用者,不可被指向别处
        uint256 minted;

        for (uint256 i = 0; i < n; i++) {
            // 任一份失败就整笔回滚(new 不 try/catch)—— 对「要么都成、要么都不花钱」最安全。
            new Minter{value: perMint}(drop, mintData, perMint, nft, user);
            minted++;
        }

        // 花剩下的全额退回调用者,合约结束时自身余额为 0。
        uint256 leftover = address(this).balance;
        if (leftover > 0) {
            (bool ok, ) = payable(user).call{value: leftover}("");
            require(ok, "refund failed");
        }
        emit Batch(user, drop, n, minted, perMint * n);
    }

    // 不接受无来由的转账(没有 receive/fallback 收钱逻辑之外的入口),
    // 唯一能进钱的地方是 batchMint,且同一笔交易内清零。
}
