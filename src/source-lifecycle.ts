export type SourceOpenDecision = "detect" | "open" | "ignore";

type DetectionState = "detecting" | "plain" | "encrypted";

export class SourceLifecycle {
  private readonly detection = new Map<string, DetectionState>();
  private readonly sessions = new Set<string>();

  beginDetection(sourcePath: string): boolean {
    if (this.detection.has(sourcePath) || this.sessions.has(sourcePath)) {
      return false;
    }
    this.detection.set(sourcePath, "detecting");
    return true;
  }

  detectionCompleted(sourcePath: string, encrypted: boolean): boolean {
    if (this.detection.get(sourcePath) !== "detecting") {
      return false;
    }
    this.detection.set(sourcePath, encrypted ? "encrypted" : "plain");
    return true;
  }

  detectionFailed(sourcePath: string): void {
    if (this.detection.get(sourcePath) === "detecting") {
      this.detection.delete(sourcePath);
    }
  }

  markEncrypted(sourcePath: string): void {
    this.detection.set(sourcePath, "encrypted");
  }

  sessionOpened(sourcePath: string): void {
    this.markEncrypted(sourcePath);
    this.sessions.add(sourcePath);
  }

  sessionClosed(sourcePath: string): void {
    this.sessions.delete(sourcePath);
  }

  sourceClosed(sourcePath: string): void {
    this.detection.delete(sourcePath);
  }

  sourceOpened(sourcePath: string): SourceOpenDecision {
    if (this.sessions.has(sourcePath)) {
      return "ignore";
    }
    const detection = this.detection.get(sourcePath);
    if (detection === "encrypted") {
      return "open";
    }
    return detection === undefined ? "detect" : "ignore";
  }
}
