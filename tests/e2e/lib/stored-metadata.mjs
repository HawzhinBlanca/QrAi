export function parseCompleteStoredMetadata(document) {
  if (typeof document !== "string") throw new TypeError("stored metadata must be text");
  // The filesystem adapter writes one JSON document plus a final newline. With `flag: "wx"` the
  // name is visible before writeFile has necessarily emitted every byte, so absence of that last
  // byte means "publication in progress", not corrupt JSON. A terminated malformed document still
  // reaches JSON.parse and fails loudly.
  if (!document.endsWith("\n")) return null;
  return JSON.parse(document);
}
