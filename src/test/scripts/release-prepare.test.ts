/**
 * release:prepare writes the CHANGELOG section and the version at the bump,
 * which is what lets CI stop checking them on every push.
 */
import { describe, expect, test } from 'bun:test';
import { bumpVersion, scaffoldChangelogText } from '../../../scripts/release-prepare.ts';

const CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to the GoodVibes daemon.',
  '',
  '## [1.29.0] - 2026-09-30',
  '',
  '### Changes',
  '',
  '- the previous release',
  '',
  '---',
  '',
  '## [1.28.20] - 2026-08-21',
  '',
  '- an older release',
  '',
].join('\n');

describe('scaffoldChangelogText', () => {
  test('a new version gets its section above the newest one, not below a separator', () => {
    const out = scaffoldChangelogText(CHANGELOG, '1.30.0', '2026-10-01');
    const headings = out.split('\n').filter((line) => line.startsWith('## '));
    expect(headings).toEqual(['## [1.30.0] - 2026-10-01', '## [1.29.0] - 2026-09-30', '## [1.28.20] - 2026-08-21']);
    // Everything that was there is still there, in order, after the new section.
    expect(out.endsWith(CHANGELOG.slice(CHANGELOG.indexOf('## [1.29.0]')))).toBe(true);
    expect(out.startsWith('# Changelog\n\nAll notable changes to the GoodVibes daemon.\n\n## [1.30.0]')).toBe(true);
  });

  test('a version that already has a section is left alone', () => {
    expect(scaffoldChangelogText(CHANGELOG, '1.29.0', '2026-10-01')).toBe(CHANGELOG);
  });

  test('a version that is a prefix of an existing one still gets its own section', () => {
    const out = scaffoldChangelogText(CHANGELOG, '1.28.2', '2026-10-01');
    expect(out).toContain('## [1.28.2] - 2026-10-01');
  });

  test('a changelog with no sections yet gets one appended', () => {
    const out = scaffoldChangelogText('# Changelog\n', '0.1.0', '2026-10-01');
    expect(out).toBe('# Changelog\n\n## [0.1.0] - 2026-10-01\n\n### Changes\n\n- \n\n');
  });
});

describe('bumpVersion', () => {
  test('patch, minor and major reset the lower parts', () => {
    expect(bumpVersion('1.29.3', 'patch')).toBe('1.29.4');
    expect(bumpVersion('1.29.3', 'minor')).toBe('1.30.0');
    expect(bumpVersion('1.29.3', 'major')).toBe('2.0.0');
  });

  test('a version that is not semver is refused rather than guessed at', () => {
    expect(() => bumpVersion('latest', 'patch')).toThrow('not semver');
  });
});
