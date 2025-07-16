import type { Readable } from 'node:stream';

export interface InkIO {
  stdin: Readable;
  setRawMode?: (enabled: boolean) => void;
  isRawModeSupported: boolean;
}

let io: InkIO | null = null;

export function setInkIO(i: InkIO) {
  io = i;
}

export function getInkIO(): InkIO | null {
  return io;
} 