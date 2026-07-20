/**
 * Bounded newline-delimited buffer accumulator (§ Production Hardening — Phase 6
 * packet-flood audit). The AVR (CR-delimited) and HEOS (CRLF-delimited) Telnet
 * drivers both accumulate inbound TCP chunks into a buffer and split on their
 * delimiter — previously duplicated per-driver with NO upper bound, so a
 * misbehaving or malicious device that never sends a delimiter could grow the
 * buffer without limit until the process runs out of memory. One shared, bounded
 * implementation for both, so a future Telnet-style driver gets this for free
 * instead of copy-pasting the same unbounded accumulator a third time.
 */
export class LineAccumulator {
  private buffer = "";

  constructor(
    private readonly delimiter: string,
    /** Real AVR/HEOS status tokens are well under 1KB; 64KB is generous headroom
     * for a burst of several hundred queued lines, while still catching a device
     * that's flooding data with no delimiter long before it threatens memory. */
    private readonly maxBytes = 64 * 1024,
    private readonly onOverflow?: (droppedBytes: number) => void,
  ) {}

  /** Feed one chunk of raw socket data; returns every complete line it now contains
   * (never including the trailing partial line, which is retained for the next feed). */
  feed(chunk: string): string[] {
    this.buffer += chunk;
    if (this.buffer.length > this.maxBytes) {
      const dropped = this.buffer.length;
      this.buffer = "";
      this.onOverflow?.(dropped);
      return [];
    }
    const lines = this.buffer.split(this.delimiter);
    this.buffer = lines.pop() ?? "";
    return lines;
  }
}
