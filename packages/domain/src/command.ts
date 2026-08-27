export interface CommandSpec {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwdRelative?: string;
}
