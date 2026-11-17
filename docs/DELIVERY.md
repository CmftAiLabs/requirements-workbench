# 最终 PRD 交付协议

此协议是需求平台的第一版接收适配约定，需要知识中台与 TeamMate 分别提供接收接口或由接入层转换；不假定现有平台已经支持。

服务端环境变量：`KNOWLEDGE_DELIVERY_URL`、`KNOWLEDGE_DELIVERY_TOKEN`、`TEAMMATE_DELIVERY_URL`、`TEAMMATE_DELIVERY_TOKEN`。令牌仅在服务端作为 Bearer 使用。接口配置后重启应用生效。

## 请求

对两个目标分别发送 `POST` JSON，带 `Idempotency-Key: <deliveryId>:<target>`。重试复用同一幂等键、PRD 版本和内容。

```json
{
  "idempotencyKey": "delivery-id:knowledge",
  "project": {"id": "project-id", "name": "项目名称"},
  "version": "V1.0.0",
  "document": {
    "title": "项目名称 PRD",
    "format": "markdown",
    "content": "最终产品需求文档正文",
    "sha256": "正文 SHA-256"
  }
}
```

其中只有最终 PRD 与必要交付元数据，不发送独立卡片对象、原材料、完整聊天或未采纳建议。PRD 自身包含已确认规则、必要依据引用及确认记录。

## 成功回执

HTTP 2xx，同时返回：

```json
{"accepted": true, "receiptId": "目标系统可查询的文档或接收记录编号"}
```

仅有 HTTP 200 而没有明确回执，不计为成功。接收端应在保存成功后返回 accepted；重复幂等键应返回原回执，内容摘要不同时应拒绝覆盖。

一端失败时保留另一端成功记录，只重试失败端。重试同一冻结文档；两端均成功后才登记已交付。请求超时为 30 秒，不跟随重定向转发令牌。

## 本地验收模式

在 `data/receipts/knowledge/` 和 `data/receipts/teammate/` 各保存一份请求包，执行内容摘要与幂等检查。记录明确标注为本地验收，不代表真实知识中台或 TeamMate 已接收。

本地验收的交付轮次不能中途切换为真实接口。正式对接后应使用新的项目/需求版本进入交付，保留原验收历史。
