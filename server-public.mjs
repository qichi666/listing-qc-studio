#!/usr/bin/env node
/**
 * 部署用启动入口（线上分享用）。
 *
 * 为什么单独一个文件，而不是直接改 server.mjs：
 *   server.mjs 的默认行为是 HOST=127.0.0.1 —— **只监听本机、不对外暴露**，
 *   这是本地开发与「密钥不出本机」的约定，不能为了部署把它改掉。
 *   线上要求监听 0.0.0.0、端口取 process.env.PORT，且 Host 头校验要认识外部域名，
 *   所以这里只补这三个部署参数；其余逻辑一律复用 server.mjs（同一份实现，不复制）。
 *
 * 本地想保持"只监听本机"：HOST=127.0.0.1 node server-public.mjs
 */
process.env.HOST = process.env.HOST || "0.0.0.0";

// 公网域名白名单。分享链接的域名由平台分配，重新发布不会变，所以写在这里。
// 换域名时只改这一行（或多传一个 PUBLIC_HOSTS，逗号分隔）。
process.env.PUBLIC_HOSTS =
  process.env.PUBLIC_HOSTS || "ai-ecommerce-portfolio.app.workbuddy.host";

// 线上不落密钥：.env.local 在容器里没有意义，也避免访客通过 /api/config 写坏配置。
process.env.LISTING_NO_KEY_WRITE = process.env.LISTING_NO_KEY_WRITE || "1";

await import("./server.mjs");
