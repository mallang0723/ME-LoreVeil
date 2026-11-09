# Changelog

## 0.2.0

- **Breaking:** Renamed the exclusion marker from `wi-exclude` to `loreveil`.
  Use `<loreveil>…</loreveil>`, `!--LOREVEIL_START--!…!--LOREVEIL_END--!`,
  or an HTML element with a `loreveil` attribute. Old markers are no longer
  recognized; update existing messages and status-block regex output.
- Changed the fast-path check to `/loreveil/i`; parsing and scan-only behavior
  otherwise remain unchanged.

## 0.1.0

- Initial release for Marinara Engine 2.5.1 and 2.5.2.
