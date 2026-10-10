# sacrifice-mint

> ⚠️ **仅供学习与交流分享，不是产品、不提供服务、不构成任何建议。**
> 代码按「现状」提供，未经专业审计公司审计。链上交易不可逆，使用造成的任何损失由使用者自行承担；
> 超过项目设定的每钱包上限是否违反该项目、交易市场的规则或你所在地的法律法规，由你自己判断并负责。
> 作者不收费、不托管资产、不代持私钥。完整免责声明见 [`LICENSE`](LICENSE)。
>
> **For learning and sharing only — not a product, not a service, not advice.** Provided as-is, not audited by a
> professional firm. On-chain transactions are irreversible and any loss is yours. Whether exceeding a project's
> per-wallet limit breaks that project's rules, a marketplace's terms, or your local law is yours to judge.
> No fees, no custody, no keys held. Full disclaimer in [`LICENSE`](LICENSE).

一笔交易铸多份 NFT，绕过 OpenSea SeaDrop 公售的每钱包上限。**非托管**：不碰私钥、不代签、不收费，交易由你自己的钱包签名发送。

> Mint more than a SeaDrop public sale's per-wallet cap in one transaction, from your own wallet. Non-custodial, free, MIT.

## 内容

| 文件 | 作用 |
|---|---|
| `SKILL.md` | 给 AI agent（Claude Code 等）用的说明：规则、流程、地址、限制 |
| `contracts/SacrificeMinter.sol` | 工厂 + 一次性 Minter 合约（solc 0.8.26） |
| `scripts/probe.mjs` | 兼容性检查：这个合约能不能批量铸（只读） |
| `scripts/plan.mjs` | 读公售参数 → 最省 gas 的方案 → 生成交易 → 模拟（只读，不签名） |

两个脚本零依赖，Node.js 18+ 直接运行。

## 快速开始

```bash
# 1. 能不能做
node scripts/probe.mjs --rpc https://rpc.mainnet.chain.robinhood.com --nft 0x<NFT合约>

# 2. 规划 + 模拟（--from 填你自己的钱包，只用来模拟）
node scripts/plan.mjs --rpc https://rpc.mainnet.chain.robinhood.com --nft 0x<NFT合约> \
  --total 20 --factory 0xcf37f60c104aa82f7aadd0aa70eeeb0742324424 --from 0x<你的钱包>
```

模拟全部通过后，把输出里的交易（`to` / `data` / `value`）在你自己的钱包里发出：先工厂那笔，再直接铸那笔。

作为 Claude Code skill 使用：把整个目录放到 `~/.claude/skills/sacrifice-mint/`（或项目的 `.claude/skills/`），对 Claude 说「帮我在这个盘铸 20 个」即可。

## 实测（Robinhood 主网，模拟）

Punks and Pals（每钱包上限 6）要 20 个 → 方案：3 个 Minter × 6 + 你自己的钱包 2 个；工厂交易约 1.14M gas，直接铸约 11 万 gas，模拟全部通过。

## 风险

链上交易不可逆，失败的 gas 不退。超过项目设定的每钱包上限，是否违反该项目或市场的规则，由你自己判断。合约未经专业审计公司审计，详见 `SKILL.md` 与 `LICENSE`。
