(function (root) {
  'use strict';
  const supported = ['IPRS', 'PRS', 'ASCAP'];
  const clean = value => String(value ?? '').normalize('NFKC').trim();
  const identity = value => clean(value).replace(/\s+/g, ' ').toLocaleLowerCase();
  const clone = value => JSON.parse(JSON.stringify(value));
  const durationSeconds = cue => Number.isFinite(Number(cue?.duration)) ? Math.max(0, Number(cue.duration)) : 0;

  function indexArtists(artists = []) {
    if (artists?.byId instanceof Map) return artists;
    const result = { artists, byId: new Map(), byIpi: new Map(), byName: new Map() };
    const add = (map, key, artist) => { if (key) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(artist); } };
    for (const artist of artists) {
      result.byId.set(artist.id, artist);
      add(result.byIpi, identity(artist.ipi), artist);
      for (const name of [artist.name, ...(artist.aliases || [])]) add(result.byName, identity(name), artist);
    }
    return result;
  }

  function parse(value) {
    if (Array.isArray(value)) {
      const tokens = [...new Set(value.flatMap(parse))];
      // Older versions saved non-member labels as separate membership tokens.
      if (tokens.includes('NON') && (tokens.includes('MEMBER') || tokens.includes('SOCIETY'))) {
        return [...new Set(tokens.filter(token => !['NON', 'MEMBER', 'SOCIETY'].includes(token)).concat('NON-MEMBER'))];
      }
      return tokens;
    }
    if (value && typeof value === 'object') return parse(Object.entries(value).filter(([, enabled]) => enabled === true).map(([name]) => name));
    // NS is an explicit non-society affiliation, not a collecting society.
    const normalized = clean(value).toUpperCase()
      .replace(/\bNON[\s-]*(?:MEMBER|SOCIETY)\b/g, 'NON-MEMBER')
      .replace(/(^|[^A-Z0-9.-])N\.?\s*S\.?(?=$|[^A-Z0-9.-])/g, '$1NON-MEMBER');
    return [...new Set((normalized.match(/[A-Z][A-Z0-9-]*/g) || []).filter(token => !['AND', 'OR', 'NONE', 'UNKNOWN', 'NA', 'N', 'A'].includes(token)))];
  }

  const label = value => {
    const affiliations = parse(value);
    return affiliations.length === 1 && affiliations[0] === 'NON-MEMBER' ? 'Non-society' : clean(value);
  };

  function findArtist(record, artists = []) {
    if (artists?.byId instanceof Map) {
      if (record?.artistId) return artists.byId.get(record.artistId);
      if (record?.id && artists.byId.has(record.id)) return artists.byId.get(record.id);
      const ipi = identity(record?.ipi), matches = ipi ? artists.byIpi.get(ipi) : artists.byName.get(identity(record?.name));
      return matches?.size === 1 ? [...matches][0] : null;
    }
    if (record?.artistId) return artists.find(artist => artist.id === record.artistId);
    if (record?.id) {
      const exact = artists.find(artist => artist.id === record.id);
      if (exact) return exact;
    }
    const ipi = identity(record?.ipi), name = identity(record?.name);
    const matches = artists.filter(artist => ipi ? identity(artist.ipi) === ipi : name && [artist.name, ...(artist.aliases || [])].some(alias => identity(alias) === name));
    return matches.length === 1 ? matches[0] : null;
  }

  function memberships(record, artists = []) {
    if (Array.isArray(record?._exportMemberships)) return parse(record._exportMemberships);
    const recorded = parse([record?.society, record?.societies]);
    // A contributor's explicit non-member credit overrides stale linked profiles.
    if (recorded.length === 1 && recorded[0] === 'NON-MEMBER') return recorded;
    const artist = findArtist(record, artists);
    return parse([record?.society, record?.societies, artist?.societies]);
  }

  const has = (record, society, artists = []) => memberships(record, artists).includes(clean(society).toUpperCase());
  const isNonMember = (record, artists = []) => {
    const affiliations = memberships(record, artists);
    return affiliations.length === 1 && affiliations[0] === 'NON-MEMBER';
  };
  const exportEligible = (record, society, artists = []) => has(record, society, artists) || isNonMember(record, artists);

  function performers(work, artists = []) {
    if (Array.isArray(work?._exportPerformers)) return clone(work._exportPerformers);
    const linked = (work?.artistIds || []).map(id => findArtist({ artistId: id }, artists)).filter(Boolean);
    if (linked.length) return linked.map(artist => ({ name: artist.name, artistId: artist.id, ipi: artist.ipi, _exportMemberships: memberships(artist, artists) }));
    const name = clean(work?.artist);
    if (!name) return [];
    const artist = findArtist({ name }, artists);
    return [{ name, ...(artist ? { artistId: artist.id, ipi: artist.ipi } : {}), _exportMemberships: memberships(artist || { name }, artists) }];
  }

  function freezeWorks(works, artists = []) {
    artists = indexArtists(artists);
    return works.map(work => ({ ...clone(work), parties: (work.parties || []).map(party => ({ ...clone(party), _exportMemberships: memberships(party, artists) })), _exportPerformers: performers(work, artists) }));
  }

  const workSocieties = (work, artists = []) => parse([...(work?.parties || []).map(party => memberships(party, artists)), ...performers(work, artists).map(artist => memberships(artist, artists))]);

  function records(works, artists = []) {
    artists = indexArtists(artists);
    const result = new Map();
    for (const record of [...artists.artists, ...works.flatMap(work => [...(work.parties || []), ...performers(work, artists)])]) {
      if (!clean(record.name)) continue;
      const linked = findArtist(record, artists), key = linked?.id || record.artistId || record.id || (identity(record.ipi) ? 'ipi:' + identity(record.ipi) : 'name:' + identity(record.name));
      const prior = result.get(key);
      result.set(key, { key, name: record.name, societies: parse([prior?.societies, memberships(record, artists)]) });
    }
    return [...result.values()];
  }

  function summary({ works = [], cues = [], artists = [] } = {}) {
    artists = indexArtists(artists);
    const people = records(works, artists), result = {
      totalArtists: people.length, unknownArtists: people.filter(record => !record.societies.length).length,
      prsOnlyArtists: people.filter(record => record.societies.includes('PRS') && !record.societies.includes('IPRS')).length,
      dualArtists: people.filter(record => record.societies.includes('IPRS') && record.societies.includes('PRS')).length,
    };
    for (const society of supported) {
      // A society cue row requires a member or explicitly marked non-member. Performers
      // are counted as artists but cannot stand in for an ownership contributor.
      const selected = works.filter(work => (work.parties || []).some(party => exportEligible(party, society, artists))), ids = new Set(selected.map(work => work.id));
      const uses = cues.filter(cue => ids.has(cue.workId));
      result[society] = { artists: people.filter(record => record.societies.includes(society)).length, songs: selected.length, cues: uses.length, duration: uses.reduce((sum, cue) => sum + durationSeconds(cue), 0) };
    }
    return result;
  }

  function scope(cues, works, society, artists = [], options = {}) {
    society = clean(society).toUpperCase();
    if (!supported.includes(society)) throw new Error('Unsupported society: ' + society);
    const linkedIds = new Set(cues.map(cue => cue.workId)), originals = freezeWorks(works.filter(work => linkedIds.has(work.id)), artists);
    // Format copies retain recorded affiliations rather than inventing membership.
    if (['PRS', 'ASCAP'].includes(society) && ['recorded-affiliations-v1', 'as-entered-v1'].includes(options.membershipPolicy)) {
      return {
        cues: cues.map(clone), works: originals.map(work => ({ ...work, _exportSociety: society })),
        summary: { ...summary({ works: originals, cues }), society, includedCues: cues.length, excludedCues: 0, membershipPolicy: options.membershipPolicy },
      };
    }
    const selected = originals.map(work => {
      const parties = work.parties.filter(party => exportEligible(party, society));
      return { ...work, _exportSociety: society, parties: parties.map(party => ({ ...party, society: isNonMember(party) ? 'Non Member' : society })), artist: work._exportPerformers.filter(artist => has(artist, society)).map(artist => artist.name).join(', '), _exportPerformers: work._exportPerformers.filter(artist => has(artist, society)) };
    }).filter(work => work.parties.length);
    const eligible = new Set(selected.map(work => work.id)), selectedCues = cues.filter(cue => eligible.has(cue.workId)).map(clone);
    return { cues: selectedCues, works: selected, summary: { ...summary({ works: originals, cues }), society, includedCues: selectedCues.length, excludedCues: cues.length - selectedCues.length } };
  }

  const api = { supported, parse, label, memberships, has, isNonMember, performers, freezeWorks, workSocieties, summary, scope, indexArtists };
  root.CueSocieties = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
