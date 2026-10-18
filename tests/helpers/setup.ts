import { fromWorkspace } from "anchor-litesvm";
import { resolve } from "node:path";

export function createTestSvm() {
  return fromWorkspace(resolve("."));
}
