# 模型网关补充证书链

公开 CA 证书，不包含任何私钥或模型密钥。

- YE1：来自网关叶证书 Authority Information Access 指定的 `http://ye1.i.lencr.org/`。
- Root YE 交叉签名证书：来自 YE1 的 AIA `http://ye.i.lencr.org/`，签发者为 ISRG Root X2。
- 已以 Node 默认 `tls.rootCertificates` 为根，执行 `openssl verify -CAfile <Node根证书> -untrusted root-ye-cross.pem letsencrypt-ye1.pem`，返回 OK。
- `model-chain.pem` 为以上两份公开证书的合并，用于补齐网关缺失链，保持正常 TLS 校验。

正式网关应配置 CA 提供的完整 fullchain。官方说明：https://letsencrypt.org/certificates/
