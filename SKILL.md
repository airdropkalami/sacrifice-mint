---
name: sacrifice-mint
description: Plan and simulate a ×N mint of an OpenSea SeaDrop PUBLIC sale beyond the per-wallet limit, using one-shot "sacrifice" Minter contracts that the user's own wallet deploys and pays for in a single transaction. Use when the user asks to mint more NFTs than a drop's per-wallet cap allows, to check whether a drop can be batch-minted, or to build the transaction for it. Non-custodial: this skill never holds keys, never signs, never sends — it outputs transactions for the user to send from their own wallet.
---

# Sacrifice Mint（一次性铸造合约批量铸造）

一笔交易里铸多份、绕过每钱包上限：工厂合约在**同一笔交易**内部署 N 个一次性 `Minter` 合约，
每个 Minter 都是一个独立的 `msg.sender`，各自领一份每钱包额度，铸到的 NFT 在同一笔交易里全部转回下单的钱包。
这是 NFT 圈多年来的公开做法（sacrifice minter），不是新发明。

> 仅供学习与交流分享。未经专业审计；使用风险与合规责任由使用者自行承担（完整免责声明见 `LICENSE`）。

## 你（agent）必须遵守的规则

1. **永远不要索取、读取、保存或使用用户的私钥 / 助记词。** 这个 skill 只读链、只模拟；交易由用户在自己的钱包里签名发送。
2. **先模拟，模拟不过就不发。** `scripts/plan.mjs` 会对每笔交易做 `eth_estimateGas`；任何一笔 `simulation.ok=false` 就告诉用户原因，不要让用户发。
3. **把规则说清楚再动手。** 告诉用户：这样做会超过项目设定的每钱包上限，是否违反该项目或市场的规则、是否合规，由用户自己判断并承担后果；链上交易不可逆，失败的 gas 不退。
4. **只做 SeaDrop 公售。** 白名单 / 签名 / 预售阶段做不了（临时地址不在白名单里）；不是 SeaDrop 的合约脚本会直接说不行。
5. **核对链和工厂地址。** 工厂必须部署在 drop 所在的那条链上（见下表），地址写错交易会失败。

## 流程

### 1. 兼容性检查（只读）

```bash
node scripts/probe.mjs --rpc <该链 RPC> --nft <NFT 合约地址>
```

- `compatible`：字节码里完全没有 `tx.origin`，每钱包上限不可能按发起钱包记 → 可以做。
- `uncertain`：用到了 `tx.origin`，上限可能按它记 → 以第 2 步的模拟结果为准。
- `incompatible`：有 `require(msg.sender == tx.origin)` → 任何合约调用都会失败，做不了。

自动穿透 EIP-1167 / EIP-1967 代理。`EXTCODESIZE`（反合约检查）不是问题：Minter 在自己的构造函数里铸造，那时它的代码长度是 0，看起来就是一个钱包。

### 2. 规划 + 模拟（只读，不签名）

```bash
node scripts/plan.mjs --rpc <RPC> --nft <NFT 地址> --total <想要的数量> --factory <工厂地址> --from <用户自己的钱包>
```

脚本会：
1. 从 SeaDrop 单例 `0x00005EA00Ac477B1030CE78506496e8C2dE24bf5` 读公售：价格、开始/结束时间、每钱包上限、手续费收款地址；
2. 读剩余供应量，售罄或不够会直接说；
3. 选**最省 gas 的方案**：上限够就直接单钱包铸，一个 Minter 都不用；不够才用最少的地址数 `ceil(总数 / 上限)`，用户自己的钱包铸余数，每个 Minter 铸满上限；
4. 生成交易 `{to, data, value}` 并逐笔模拟。

把输出里的交易给用户，**先发工厂那一笔，再发直接铸的那一笔**，发完让用户核对 NFT 数量。

### 3. 交易的含义（给用户解释用）

- 工厂交易：`batchMint(drop, mintData, perMint, nft, n)`，`value = 单价 × 每个 Minter 的数量 × Minter 数`。
- 收款人在合约里**硬编码为发交易的钱包**，没有收款地址参数，NFT 和多余的 ETH 只会回到发交易的那个钱包。
- 任何一个 Minter 没把 NFT 如数转回，整笔回滚：不会出现「付了钱、NFT 卡在合约里」。

## 工厂地址

| 链 | 地址 | 状态 |
|---|---|---|
| Robinhood Chain（4663） | `0xcf37f60c104aa82f7aadd0aa70eeeb0742324424` | 主网在用；链上字节码与 `contracts/SacrificeMinter.sol` 编译结果逐字节一致（solc 0.8.26, optimizer 200, evmVersion paris） |
| Sepolia（测试网） | `0x4343fc4f450df5e1538c027b7482980eb5c87f39` | 真 SeaDrop 单例公售端到端测试用 |

其他链需要自己部署一份（下一节）。同一份字节码用同一个部署者 + 同一个 salt 走 CREATE2，可以在多条链上得到同一个地址。

## 自己部署工厂

1. 编译 `contracts/SacrificeMinter.sol`：solc **0.8.26**，optimizer **开、200 runs**，evmVersion **paris**（Remix 或 Foundry 都行）。
2. 用一个只放少量 gas 费的**一次性钱包**部署 `SacrificeMinter`（无构造参数、无 owner）。
3. 在区块浏览器上 verify 源码，让别人能核对。
4. 先在测试网或一个真实的小盘上用 `--total` 很小的数做一次，确认 NFT 全部回到钱包，再正式用。

## 已知限制

- 只适合**顺序发号**的 ERC721A / SeaDrop 盘（Minter 用 `totalSupply` 区间 + `ownerOf` 认领自己铸到的 token）。非顺序发号、没有 `totalSupply()`、ERC-1155 的盘会整笔回滚（不会丢钱，但用不了）。
- 每钱包上限按 `tx.origin` 记的盘做不了；有 `msg.sender == tx.origin` 守卫的盘做不了。
- 每个 Minter 多付一次部署 + 一次转账：实测约 115k–130k gas / 个。L2 上很便宜，以太坊主网要先算清楚。
- 链上硬上限 `n ≤ 100`。

## 安全与审计状态

- 结构上偷不走钱：无 owner / admin / 升级 / selfdestruct，无 approve；合约能动用的上限就是这一笔交易发进来的 value，交易结束合约余额为 0。
- 已做：Sepolia 两轮端到端验证（测试盘 ×5、真 SeaDrop 公售 ×4）；一次对抗性 AI 审计，修复两个自损问题（H-1 多付退款可能锁死、M-1 非标 `transferFrom` 静默失败）后复测通过。
- **未做：专业审计公司的正式审计。** 主网使用风险自担，先小额。

## 来源

由 A8之路（a8journey）开源，MIT 许可，附免责声明，见 `LICENSE`。不收费、不托管、不代持私钥。
