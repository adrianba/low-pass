export class ReleaseKey {
  private held = false;
  down(repeat: boolean): boolean {
    const accepted = !repeat && !this.held;
    this.held = true;
    return accepted;
  }
  up(): void { this.held = false; }
}
