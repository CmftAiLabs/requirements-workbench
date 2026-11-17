# 当前网关的模型适配验证（2026-11-13）

范围：当前配置网关的五个精确 ID；结果不代表同名模型在其他网关上的行为。测试不修改真实项目，不自动发布评估。

## 思考参数

| 模型 | 已采用参数 | 有效值 / 无效值对照 | 其他发现 |
| --- | --- | --- | --- |
| cmft-qwen3.8-flash-next | reasoning_effort=low | low 成功，无效值 400 | enable_thinking=false 仍返回思考，不能宣称关闭生效 |
| qwen3.8-max | reasoning_effort=low | low 成功，无效值 400 | enable_thinking=false 本次无思考输出，但需求评估仍保留低思考 |
| CMFT-glm-5.3-flash | reasoning_effort=low | low 成功，无效值 400 | thinking.type=disabled 被接受但仍有思考输出，不采用该开关 |
| glm-5.3 | reasoning_effort=low | low 成功，无效值 400 | thinking.type=disabled 明确 400，不关闭思考 |
| claude-opus-5-5 | reasoning_effort=low | low/high 成功，无效值 400（网关转换失败） | output_config 的无效 effort 仍被接受，不用原生参数假冒兼容；/messages 未返回可解析的原生 JSON |

证据分层：HTTP 成功只证明接受请求；无效值拒绝说明网关校验/转换该参数；用量和响应差异提供行为证据，但一次采样无法证明确切内部思考预算或性能提升。Claude 的用量没有可靠区分思考 token，不能用其 reasoning_tokens=0 断定没有思考。测试不保存或展示思考原文。

适配采用现有 Mastra OpenAI-compatible provider 的 reasoningEffort，回归测试断言最终 HTTP 请求的 reasoning_effort，而不只检查配置对象。

## 实际需求评估

固定办公用品申领卡片修订 6 和同一讨论快照，包含数量 1—10、预估价格不纳入、品牌选填且不进列表、页面默认填报且提交后自动切换，以及当时等待回答的采购平台列表问题。快照之后的实时讨论不混入对比。

执行完整 evaluateRequirement：三视角报告、真实原文引用校验、追问回答校验、单次结构修复及原有只读检索。结果仅保存在本地 .work/expert-discussion，不写回群、不改字段或人工确认。

首轮：Qwen Max、GLM Flash、GLM、Claude 通过结构和原文校验，均返回三视角，引用 4—5 条原文，无新追问且 summarize=false。单次耗时分别约 59、36、20、19 秒（不是性能基准）。

Qwen Flash 首轮及一次诊断复跑失败：最终答案字符串内出现未转义双引号；修复结果又漏掉 discussion。finish_reason 为 stop，并非 token 截断。进一步尝试 JSON object 输出模式后发生重复空白输出并耗尽预算，已撤回该模式。最终保留 low 并加强转义与顶层结构提示。保留所有原文/字段校验和一次修复上限，不拼补不可信 JSON，也不自动补造缺失证据。评估结构错误现包含具体字段位置供修复。模型设置中提示此通道复杂评估的稳定性限制。

语义检查限制：模型仍可能把可选细节扩大为待确认事项，例如已经声明状态“已提交”后继续追问是否只有一个状态，或提出额外异常文案。这属于评估质量边界，不应以提高思考程度替代人工取舍。测试通过不是“全部业务意见都正确”。

## 官方参数参考

- [Qwen 思考控制](https://www.alibabacloud.com/help/en/model-studio/deep-thinking)
- [GLM 思考控制](https://docs.z.ai/guides/capabilities/thinking)
- [Claude OpenAI 兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)

网关是额外转换层：Claude 官方兼容层文档称 reasoning_effort 被忽略，但当前网关实测会校验转换它，因此以本通道实测为适配依据，不能把该结论泛化为 Claude 原生接口行为。

最终复测：Qwen Flash 在撤回 JSON 模式并加强提示后仍未通过 JSON 解析（约 73 秒，含原有一次修复）。因此明确记为未通过复杂评估验证，不将参数验证成功包装为模型任务成功。最终四个模型通过、一个未通过；278 项自动化回归全部通过，类型检查和前端构建通过。

同时修复输入区焦点样式：全局 textarea:focus-visible 覆盖聊天 textarea 的 outline:0，在圆角输入容器中被裁切成蓝色横线。聊天容器保留单层焦点边框，textarea 不再叠加 outline/box-shadow，引用问题改为单行省略（悬停显示全文）。浏览器实测 textarea outline/box-shadow 与父容器 box-shadow 均为 none，仍保留父容器焦点边框。
