// Direct macOS kernel queries via bun:ffi. These give us data `ps` can't:
// the exact argv (with original word boundaries), the initial environment,
// the real executable path, and the working directory — without spawning
// a subprocess per PID.
import { dlopen, FFIType, ptr } from "bun:ffi";

const libc = dlopen("/usr/lib/libSystem.B.dylib", {
  sysctl: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
    returns: FFIType.i32,
  },
  proc_pidpath: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
  proc_pidinfo: {
    args: [FFIType.i32, FFIType.i32, FFIType.u64, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
});

const CTL_KERN = 1;
const KERN_ARGMAX = 8;
const KERN_PROCARGS2 = 49;
const PROC_PIDVNODEPATHINFO = 9;
const PROC_PIDTBSDINFO = 3;
const BSDINFO_SIZE = 136; // sizeof(struct proc_bsdinfo); pbi_start_tvsec @120, tvusec @128
const VNODE_INFO_SIZE = 152; // sizeof(struct vnode_info)
const MAXPATHLEN = 1024;
const VNODEPATHINFO_SIZE = 2 * (VNODE_INFO_SIZE + MAXPATHLEN);

const decoder = new TextDecoder();

function argMax(): number {
  const mib = new Int32Array([CTL_KERN, KERN_ARGMAX]);
  const out = new Int32Array(1);
  const len = new BigUint64Array([4n]);
  if (libc.symbols.sysctl(ptr(mib), 2, ptr(out), ptr(len), null, 0) !== 0) return 1 << 20;
  return out[0]!;
}

const ARGBUF = new Uint8Array(argMax());
const PATHBUF = new Uint8Array(4096);
const VNBUF = new Uint8Array(VNODEPATHINFO_SIZE);
const BSDBUF = new Uint8Array(BSDINFO_SIZE);

function cstr(buf: Uint8Array, start: number, end = buf.length): string {
  let i = start;
  while (i < end && buf[i] !== 0) i++;
  return decoder.decode(buf.subarray(start, i));
}

export interface ProcArgs {
  argv: string[];
  env: Record<string, string>;
}

/** Exact argv + initial environment. Null if the process is gone or protected. */
export function procArgs(pid: number): ProcArgs | null {
  const mib = new Int32Array([CTL_KERN, KERN_PROCARGS2, pid]);
  const len = new BigUint64Array([BigInt(ARGBUF.length)]);
  if (libc.symbols.sysctl(ptr(mib), 3, ptr(ARGBUF), ptr(len), null, 0) !== 0) return null;
  const size = Number(len[0]);
  if (size < 4) return null;
  const argc = new DataView(ARGBUF.buffer).getInt32(0, true);
  let p = 4;
  // skip exec path, then NUL padding
  while (p < size && ARGBUF[p] !== 0) p++;
  while (p < size && ARGBUF[p] === 0) p++;
  const argv: string[] = [];
  for (let i = 0; i < argc && p < size; i++) {
    const s = cstr(ARGBUF, p, size);
    argv.push(s);
    p += Buffer.byteLength(s) + 1;
  }
  const env: Record<string, string> = {};
  while (p < size) {
    const s = cstr(ARGBUF, p, size);
    if (s.length === 0) break;
    p += Buffer.byteLength(s) + 1;
    const eq = s.indexOf("=");
    if (eq > 0) env[s.slice(0, eq)] = s.slice(eq + 1);
  }
  return { argv, env };
}

/** Absolute path of the executable image. */
export function procPath(pid: number): string | null {
  const n = libc.symbols.proc_pidpath(pid, ptr(PATHBUF), PATHBUF.length);
  return n > 0 ? decoder.decode(PATHBUF.subarray(0, n)) : null;
}

/** Current working directory. */
export function procCwd(pid: number): string | null {
  const n = libc.symbols.proc_pidinfo(pid, PROC_PIDVNODEPATHINFO, 0n, ptr(VNBUF), VNBUF.length);
  if (n <= 0) return null;
  const s = cstr(VNBUF, VNODE_INFO_SIZE, VNODE_INFO_SIZE + MAXPATHLEN);
  return s || null;
}

/** Process start time, epoch seconds with microseconds (ps only gives whole seconds). */
export function procStart(pid: number): number | null {
  const n = libc.symbols.proc_pidinfo(pid, PROC_PIDTBSDINFO, 0n, ptr(BSDBUF), BSDBUF.length);
  if (n < BSDINFO_SIZE) return null;
  const dv = new DataView(BSDBUF.buffer);
  return Number(dv.getBigUint64(120, true)) + Number(dv.getBigUint64(128, true)) / 1e6;
}
