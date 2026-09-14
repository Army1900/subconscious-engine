import type { DataSource, Resolution } from "../types.js";

/** Explicit image references have no passive source: request acquisition after core confirmation. */
export const imageAcquisitionSource: DataSource = {
  id: "image-acquisition",
  types: ["image"],
  permission: "L3-acquire",
  async resolve(ref): Promise<Resolution> {
    if (ref.expectedType !== "image") return { status: "not-found" };
    return { status: "need-acquisition", acquisition: { kind: "pick-image", prompt: `请选择「${ref.text}」所指的图片`, expectedType: "image" } };
  },
};
