# 哈Gemi 人设与运行约束

QQ 机器人「哈Gemi（Gemini 娘·四角星猫耳）」的人设、行为约束和表情贴图。机器人本体是 Google Antigravity（agy）+ NapCat（OneBot 11），记忆用 MemoryOS，找图用 [pixiv-mcp](https://github.com/go0le/pixiv-mcp)。

> 本目录是 2026-11-05 的版本。仓库其它目录里的机器人代码仍是 2026-11-01 的版本，后来的功能（记忆、主动消息、表情贴图、受限沙箱等）对应的代码还没有同步上来。

## 文件

| 路径 | 内容 |
|---|---|
| `gemini-chan.card.json` | 人设本体，[Character Card V2](https://github.com/malfoyslastname/character-card-spec-v2) 格式，可以直接导入 SillyTavern 等前端 |
| `gemini-chan.card.png` | 同一张卡的 PNG 版：`chara`（V2）和 `ccv3`（V3）文本块里内嵌了上面的 JSON |
| `rules/admin.md` | 管理员环境的 `AGENTS.md`：人设块 + 出图格式、搜图条件、R-18 规则、记忆、身份权限、群聊约束 |
| `rules/guest.md` | 普通用户环境（灰名单关闭）的 `AGENTS.md`：只能聊天和找图，不得替人在服务器上做任何工作 |
| `rules/guest-grey.md` | 白名单会话里普通用户的 `AGENTS.md`：同上，但按本轮明文请求放开灰名单 |
| `expressions/chibi/` | 22 张 Q 版表情贴图（512×512 透明 PNG） |
| `expressions/*.png` | 8 张从设定图裁出的头像表情（备用） |
| `expressions/manifest.json` | 情绪名 → 贴图文件，含同义词 |

## 怎么用

- **人设**：agy 会把运行目录里的 `AGENTS.md` 当作常驻指令。管理员环境用 `rules/admin.md`，两个受限环境各用对应的文件，放到各自的工作目录里命名为 `AGENTS.md`。
- **规则优先级**：出图格式、权限分层、记忆和群聊约束都是硬性规则，写明优先于人设，防止为了「入戏」破坏格式或越权。
- **表情贴图**：模型在回复开头写 `[表情:名]`（名字见 `manifest.json`），机器人把它换成对应的贴图发出，并从文字里去掉标记。
- **记忆**：机器人按 QQ 号检索记忆，以 `[记忆…]` 段落放进每轮消息开头；人设要求她把这些当作自己的回忆，不自己调用记忆工具。
- **找图**：Pixiv 检索在人设里是她的「四角星之力」，由 pixiv-mcp 提供。

## 来源

- 外貌依据作者的「Gemini 娘·四角星猫耳」设定图（设定图本身未随仓库发布）。
- Q 版贴图由 Gemini 图像模型生成，参考图只用了上面这张设定图，没有使用他人的作品。
