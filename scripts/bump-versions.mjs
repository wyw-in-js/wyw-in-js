import { cwd } from 'node:process';

import { getReleasePlan } from '@changesets/get-release-plan'; // eslint-disable-line import/no-unresolved
import writeChangeset from '@changesets/write';
import semver from 'semver';

import { getWorkspaces } from './helpers/getWorkspaces.mjs';

const { releases } = await getReleasePlan(cwd(), undefined, {});
const workspaces = getWorkspaces(cwd(), { includePrivate: false });
const publishableWorkspaceNames = new Set(Object.keys(workspaces));
const publishableReleases = releases.filter((release) =>
  publishableWorkspaceNames.has(release.name)
);

const shouldAlignAll = publishableReleases.some(
  (release) => release.type === 'major' || release.type === 'minor'
);

if (!shouldAlignAll) {
  console.log('No version alignment needed');
  process.exit(0);
}

const maxVersion = publishableReleases.reduce((acc, release) => {
  workspaces[release.name] = release.newVersion;

  if (!acc) {
    return release.newVersion;
  }

  if (!release.newVersion) {
    return acc;
  }

  return semver.gt(release.newVersion, acc) ? release.newVersion : acc;
}, null);

const maxVersionParsed = semver.parse(maxVersion);
if (!maxVersionParsed) {
  throw new Error(`Cannot parse max version: ${maxVersion}`);
}

const changeset = {
  confirmed: true,
  releases: [],
  summary: 'Bump versions',
};

Object.entries(workspaces).forEach(([name, version]) => {
  const parsed = semver.parse(version);

  if (!parsed) {
    return;
  }

  if (parsed.major !== maxVersionParsed.major) {
    changeset.releases.push({
      name,
      type: 'major',
    });
    return;
  }

  if (parsed.minor !== maxVersionParsed.minor) {
    changeset.releases.push({
      name,
      type: 'minor',
    });
    return;
  }

  if (parsed.patch !== maxVersionParsed.patch) {
    changeset.releases.push({
      name,
      type: 'patch',
    });
  }
});

if (changeset.releases.length === 0) {
  console.log('No changeset needed');
  process.exit(0);
}

const changesetID = await writeChangeset.default(changeset, cwd());

console.log(`Created changeset ${changesetID}.md`);
