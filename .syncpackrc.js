module.exports = {
  versionGroups: [
    {
      dependencies: ["$LOCAL"],
      dependencyTypes: ["dev"],
      packages: ["**"],
      pinVersion: "workspace:*"
    }
  ]
};
