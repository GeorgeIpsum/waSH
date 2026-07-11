const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26-char Crockford-base32 ULID: 10 time chars + 16 random chars. */
export function ulid(now: number = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENC[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ENC[bytes[i]! & 31]!;
  return ts + rand;
}
