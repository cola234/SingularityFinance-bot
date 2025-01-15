# SingularityFinance 自动任务脚本

这个脚本用于自动化执行 SingularityFinance 任务。
欢迎订阅我的推特获取更多脚本：https://x.com/beiyue66
## 功能

- 领水
- 跨链操作
- SFI 和 WSFI 的相互兑换
- 质押、解除质押、claim 奖励
- 支持多个钱包并行处理
- 全自动运行，无需人工干预

## 使用教程

1. 确保系统已安装 Node.js

2. 克隆仓库：
git clone项目到本地

3. 安装依赖：
npm install


## 配置

1. 在根目录的`.env` 文件，添加 Anti-captcha API 密钥：

2. 在 `config/private_key.list` 文件中添加钱包私钥，每行一个：

## 使用

运行脚本：
node index.js


脚本将为每个钱包启动单独进程，无限循环运行，每轮任务后休眠 24 小时。

## 注意

- 本脚本使用 Anti-captcha 进行验证码解决 请保证Anti-captcha余额充足
- Anti-captcha注册链接：https://getcaptchasolution.com/dlknc8zcee
- 脚本全开源且运行在本地，使用风险自负
- 建议使用新钱包，因使用造成的损失作者不承担责任
- 根据硬件情况调整运行参数，避免过度消耗系统资源

