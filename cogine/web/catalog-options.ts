/** Optional Modelspage fields never change the default upstream catalog response. */
export const includesLegacy = (url: URL) => url.searchParams.getAll("include").some(value => value.split(",").includes("legacy"));
