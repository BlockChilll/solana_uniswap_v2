import { expect } from "chai";
import { createTestSvm } from "./helpers/setup";

describe("LiteSVM setup", () => {
  it("loads all three programs", () => {
    const svm = createTestSvm();

    expect(svm).to.exist;
  });
});
