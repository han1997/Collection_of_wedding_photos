// 独立脚本避免容器管理界面重新序列化 YAML 时丢失 JavaScript 引号。
try {
  const response = await fetch(
    `http://127.0.0.1:${process.env.PORT || 3000}/api/health`,
    { signal: AbortSignal.timeout(4000) },
  );
  const body = await response.json();
  process.exit(response.ok && body.ok && body.data.db === "ok" ? 0 : 1);
} catch {
  process.exit(1);
}
