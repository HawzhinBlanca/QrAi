/** Shared by the i18n suites. In its own module so importing it does not re-run another file's tests. */
export function leafKeys(obj, prefix = "") {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object" ? leafKeys(v, `${prefix}${k}.`) : [`${prefix}${k}`],
  );
}

export const getPath = (obj, path) => path.split(".").reduce((a, k) => a?.[k], obj);
