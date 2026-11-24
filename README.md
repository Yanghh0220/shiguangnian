# 拾光年 · iOS 云构建仓库

单代码库双端方案：本仓库是「拾光年」（cn.workbuddy.flashcardhub）的最小构建子集，
Web 业务代码（flashcard-hub/）与安卓 APK 共用同一份源码，由 GitHub Actions 的
macOS 机器自动构建未签名 IPA。

## 自动构建

- 触发方式：push 到 main 分支，或在 Actions 页面手动 Run workflow
- 产物：Actions 运行详情页底部 Artifacts → `ShiGuangNian-iOS-unsigned-*`
  下载得到 **未签名 IPA**（有效期 14 天）

## 未签名 IPA 安装到 iPhone（侧载，无需付费开发者账号）

1. 下载 artifact 中的 `ShiGuangNian-iOS-unsigned.ipa`
2. Windows 电脑安装：
   - iTunes（苹果官网版，**不是**微软商店版）
   - iCloud（官网版）
   - [Sideloadly](https://sideloadly.io)
3. iPhone 用数据线连接电脑，打开 Sideloadly：
   - 拖入 IPA，输入普通 Apple ID（免费即可）
   - Start 开始侧载，手机上会装好「拾光年」
4. 手机：设置 → 通用 → VPN 与设备管理 → 信任该 Apple ID 的开发者证书
5. 免费签名 **7 天有效期**，到期重新侧载一次即可（数据不丢失）

## 升级为正式签名（可选）

具备 Apple Developer Program 账号（$99/年）后：
- 生成 p12 证书 + provisioning profile，配置到仓库 Secrets（`IOS_P12_BASE64`、`IOS_PROFILE_BASE64`、`IOS_P12_PASSWORD`）
- 修改 workflow 增加签名步骤，产出可直接安装/上架的签名 IPA

## 构建原理

```
flashcard-hub/（Web 业务代码，与安卓共用）
        │  npx cap sync ios（CI 内自动执行）
        ▼
ios/App（Capacitor 8 生成的原生壳，CapacitorHttp 等 4 插件经 SPM 编译）
        │  xcodebuild（CODE_SIGNING_ALLOWED=NO）
        ▼
App.app → Payload 打包 → 未签名 IPA
```
