/**
 * 子进程执行（专供 ffmpeg / ffprobe）。
 *
 * 为什么不用 exec：exec 会起一个 shell，于是路径里的空格、引号、
 * 甚至文件名里的 `;` 都变成了可注入的东西。**一律用 spawn + 数组参数**，
 * 参数不经过 shell 解析。
 *
 * 为什么一定要超时并杀进程：ffmpeg 遇到损坏的媒体文件时可能挂住不返回。
 * 处理队列的并发是 1，挂住一个就等于整条流水线停摆——而那时宾客还在上传。
 */
import { spawn } from 'node:child_process';

/** 子进程输出的采集上限，防止一个畸形文件把内存打满 */
const MAX_OUTPUT = 4 * 1024 * 1024;

/**
 * 跑一个命令，等它结束。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{timeoutMs?: number, signal?: AbortSignal, cwd?: string}} [opts]
 * @returns {Promise<{stdout: Buffer, stderr: string, code: number}>}
 */
export function run(cmd, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 60_000;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, {
        // 绝不让子进程去读标准输入：ffmpeg 会因此挂住等待输入
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
    } catch (err) {
      reject(err);
      return;
    }

    const outChunks = [];
    const errChunks = [];
    let outLen = 0;
    let errLen = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(arg);
    };

    child.stdout.on('data', (d) => {
      outLen += d.length;
      if (outLen <= MAX_OUTPUT) outChunks.push(d);
    });
    child.stderr.on('data', (d) => {
      errLen += d.length;
      if (errLen <= MAX_OUTPUT) errChunks.push(d);
    });

    const killChild = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        // 已经退出了
      }
    };

    const timer = setTimeout(() => {
      killChild();
      finish(
        reject,
        new Error(`${cmd} 超时（${timeoutMs}ms），已强制结束。可能是损坏的媒体文件。`),
      );
    }, timeoutMs);

    const onAbort = () => {
      killChild();
      finish(reject, new Error(`${cmd} 被中止`));
    };
    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      // ENOENT 意味着 ffmpeg/ffprobe 没装 —— 调用方据此优雅降级
      finish(reject, err);
    });

    child.on('close', (code) => {
      finish(resolve, {
        stdout: Buffer.concat(outChunks),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        code: code ?? -1,
      });
    });
  });
}

/**
 * 命令是否可用。用于启动时探测，好在没有 ffmpeg 的环境里优雅降级
 * （比如没装 ffmpeg 的开发机）。
 * @param {string} cmd
 */
export async function isAvailable(cmd) {
  try {
    await run(cmd, ['-version'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** ffmpeg 是否带某个能力（解码器/解复用器）。 */
export async function hasCapability(cmd, kind, name) {
  try {
    const { stdout } = await run(cmd, ['-hide_banner', kind], { timeoutMs: 8000 });
    return stdout.toString('utf8').includes(name);
  } catch {
    return false;
  }
}
