import type { ConnectionKind, JouleStatus, Recording, Sample } from '../types.ts';
import { errorMessage } from '../types.ts';
import { HistoryStore } from './store.ts';

export class Recorder {
  private recording: Recording | null = null;
  private previousAt = 0;
  private gap = true;
  private chain: Promise<void> = Promise.resolve();
  constructor(
    readonly store: HistoryStore,
    private readonly saved: (recording: Recording, sample: Sample) => void,
    private readonly failed: (error: string) => void,
  ) {}
  markGap() {
    this.gap = true;
  }
  record(kind: ConnectionKind, status: JouleStatus) {
    this.chain = this.chain.then(async () => {
      try {
        if (this.recording && this.recording.kind !== kind) await this.endNow();
        if (!this.recording) this.recording = await this.store.begin(kind);
        const gapBefore = this.gap || status.at - this.previousAt > 15000;
        const sample = await this.store.append(this.recording.id, status, gapBefore);
        this.previousAt = status.at;
        this.gap = false;
        this.recording = { ...this.recording, sampleCount: this.recording.sampleCount + 1 };
        this.saved(this.recording, sample);
      } catch (error) {
        this.gap = true;
        this.failed(
          `History is not being saved: ${errorMessage(error)} You can still monitor and stop the Joule.`,
        );
      }
    });
  }
  end() {
    this.chain = this.chain
      .then(() => this.endNow())
      .catch((error) => this.failed(errorMessage(error)));
    return this.chain;
  }
  private async endNow() {
    if (this.recording) await this.store.finish(this.recording.id);
    this.recording = null;
    this.previousAt = 0;
    this.gap = true;
  }
  settled() {
    return this.chain;
  }
}
