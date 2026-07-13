import type { Errno } from "@wash/vfs";

export interface RpcRequest {
  id: number;
  op: string;
  args: unknown[];
}

export interface RpcOk {
  id: number;
  ok: true;
  value: unknown;
}

export interface RpcErr {
  id: number;
  ok: false;
  errno?: Errno;
  path?: string;
  message: string;
}

export type RpcResponse = RpcOk | RpcErr;
