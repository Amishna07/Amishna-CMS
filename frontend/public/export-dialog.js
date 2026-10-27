(function (root) {
  'use strict';

  const societies = ['IPRS', 'PRS', 'ASCAP'];
  const episodeFields = new Set(['episodeNumber', 'episodeTitle', 'airdate', 'duration']);
  const textFields = ['title', 'genre', 'language', 'productionNo', 'serialType', 'channel', 'bgComposer', 'submittedBy', 'country', 'altTitle', 'filmItemNo'];
  const creditFields = ['director', 'producer', 'company', 'cast'];
  const contactFields = ['companyName', 'contact', 'address', 'phone', 'network'];
  const clone = value => structuredClone(value);
  const clean = value => String(value ?? '').trim();
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
  const episodeLabel = value => /^\d+$/.test(clean(value)) ? clean(value).padStart(2, '0') : clean(value);
  const equalEpisode = (a, b) => a == null || b == null ? a == null && b == null : Number(a) === Number(b);
  const exportOptions = (draft, society) => ({ membershipPolicy: draft.membershipPolicies[society] || 'confirmed-members-v1' });
  function availableFormats(draft, cues, stats) {
    const counts = Object.fromEntries(societies.map(society => [society, { cues: stats[society].cues, songs: stats[society].songs }]));
    for (const society of ['PRS', 'ASCAP']) if (['as-entered-v1', 'recorded-affiliations-v1'].includes(exportOptions(draft, society).membershipPolicy)) {
      counts[society] = { cues: cues.length, songs: new Set(cues.map(cue => cue.workId)).size };
    }
    return counts;
  }

  function createDraft(options) {
    const project = clone(options.project);
    const sourceUnits = options.episodes?.length ? options.episodes : [{ episode: options.episode ?? (project.type === 'Movie' ? null : options.cues?.[0]?.episode ?? project.episodes?.[0]?.number), cues: options.cues || [] }];
    const units = sourceUnits.map(unit => ({ episode: unit.episode ?? null, cues: clone(unit.cues ?? options.cues?.filter(cue => equalEpisode(cue.episode, unit.episode)) ?? []), ...(unit.project ? { project: clone(unit.project) } : {}) }));
    const requestedIndex = units.findIndex(unit => equalEpisode(unit.episode, options.episode));
    return {
      project, works: clone(options.works || []), artists: clone(options.artists || []), units,
      selected: requestedIndex < 0 ? 0 : requestedIndex,
      type: project.type === 'Movie' ? 'Movie' : 'Series',
      scope: ['all', 'range'].includes(options.scope) ? options.scope : 'single', common: {}, perEpisode: {}, movie: {},
      rangeFrom: Math.min(...units.map(unit => Number(unit.episode))),
      rangeTo: Math.max(...units.map(unit => Number(unit.episode))),
      membershipPolicies: Object.fromEntries(['PRS', 'ASCAP'].map(society => [society, ['confirmed-members-v1', 'recorded-affiliations-v1'].includes(options.membershipPolicy) ? options.membershipPolicy : 'as-entered-v1'])),
      societies: [...societies], errors: [], busy: false, progress: '', preferences: options.preferences || {},
    };
  }

  function valuesFor(draft, index = draft.selected) {
    const unit = draft.units[index], project = unit.project || draft.project;
    const episode = (project.episodes || []).find(item => equalEpisode(item.number, unit.episode));
    const periods = project.periods || [];
    const production = project.type === 'Movie' ? periods[0] || {} : periods.find(period => unit.episode >= period.from && unit.episode <= period.to) || {};
    const selectedCues = draft.type === 'Movie' && draft.scope === 'all' ? draft.units.flatMap(item => item.cues) : unit.cues;
    const linkedWorks = draft.works.filter(work => selectedCues.some(cue => cue.workId === work.id));
    const defaults = {
      title: project.title || '', genre: project.genre || '', language: project.language || '',
      productionNo: project.productionNo || '', year: project.year ?? '',
      serialType: project.serialType || 'Web Series', channel: project.channel || '',
      season: project.season ?? '', totalEpisodes: project.totalEpisodes ?? '',
      episodeNumber: episodeLabel(unit.episode ?? 1), episodeTitle: episode?.title || '',
      duration: episode?.duration ?? project.duration ?? '', airdate: episode?.airdate ?? project.airdate ?? '',
      bgComposer: project.bgComposer || [...new Set(linkedWorks.flatMap(work => (work.parties || []).filter(party => party.role === 'Composer').map(party => clean(party.name)).filter(Boolean)))].join(', '),
      submittedBy: project.submittedBy ?? 'Amishna Music',
      country: project.country || '', altTitle: project.altTitle || '', filmItemNo: project.filmItemNo || '',
    };
    for (const key of creditFields) defaults[key] = production[key] || '';
    for (const key of contactFields) defaults['ascap_' + key] = project.ascap?.[key] || '';
    if (draft.type === 'Movie' && draft.scope === 'all' && draft.units.length > 1) {
      defaults.duration = project.duration || '';
      defaults.airdate = project.airdate || '';
      return { ...defaults, ...draft.common, ...draft.movie };
    }
    return { ...defaults, ...draft.common, ...(draft.perEpisode[index] || {}) };
  }

  function setValue(draft, key, value) {
    if (episodeFields.has(key)) {
      if (draft.type === 'Movie' && draft.scope === 'all' && draft.units.length > 1) draft.movie[key] = value;
      else (draft.perEpisode[draft.selected] ||= {})[key] = value;
    } else draft.common[key] = value;
  }

  function selectedIndices(draft) {
    if (draft.scope === 'single') return [draft.selected];
    return draft.units.map((_, index) => index).filter(index => draft.scope !== 'range' ||
      (Number(draft.units[index].episode) >= Number(draft.rangeFrom) && Number(draft.units[index].episode) <= Number(draft.rangeTo)));
  }

  function prepare(draft) {
    const errors = [], outputs = [], indices = selectedIndices(draft);
    if (!indices.length) return { outputs, errors: ['Choose a valid episode range. From episode must be no greater than To episode.'] };
    const grouped = draft.type === 'Movie' ? [indices] : indices.map(index => [index]);
    for (const group of grouped) {
      const index = draft.type === 'Movie' ? draft.selected : group[0], values = valuesFor(draft, index);
      const prefix = draft.type === 'Series' && grouped.length > 1 ? 'Source episode ' + episodeLabel(draft.units[index].episode) + ': ' : '';
      const number = Number(values.episodeNumber);
      if (!clean(values.title)) errors.push(prefix + (draft.type === 'Movie' ? 'Movie name' : 'Serial name') + ' is required.');
      if (draft.type === 'Series' && (!/^\d+$/.test(clean(values.episodeNumber)) || !Number.isSafeInteger(number) || number < 1)) errors.push(prefix + 'Episode number must be a positive whole number.');
      if (clean(values.duration) && (!Number.isFinite(root.CueDomain.seconds(values.duration)) || root.CueDomain.seconds(values.duration) <= 0)) errors.push(prefix + 'Duration must be a positive HH:MM:SS time.');
      if (clean(values.year) && (!/^\d{4}$/.test(clean(values.year)) || Number(values.year) < 1800 || Number(values.year) > 2500)) errors.push(prefix + 'Use a valid four-digit production year or leave it blank.');
      if (draft.type === 'Series') for (const [key, label, minimum] of [['season', 'Season number', 1], ['totalEpisodes', 'Total number of episodes', 0]]) {
        if (clean(values[key]) && (!/^\d+$/.test(clean(values[key])) || !Number.isSafeInteger(Number(values[key])) || Number(values[key]) < minimum)) errors.push(prefix + label + ' must be a whole number or blank.');
      }
      const sourceProject = draft.units[index].project || draft.project;
      const project = clone(sourceProject), episode = draft.type === 'Movie' ? null : number;
      project.type = draft.type;
      for (const key of textFields) project[key] = clean(values[key]);
      project.year = clean(values.year) ? Number(values.year) : '';
      project.duration = clean(values.duration);
      project.airdate = clean(values.airdate);
      project.ascap = { ...project.ascap };
      for (const key of contactFields) project.ascap[key] = clean(values['ascap_' + key]);
      project.periods = [{ from: episode ?? 1, to: episode ?? 1, ...Object.fromEntries(creditFields.map(key => [key, clean(values[key])])) }];
      if (draft.type === 'Movie') project.episodes = [];
      else {
        const originalEpisode = (sourceProject.episodes || []).find(item => equalEpisode(item.number, draft.units[index].episode));
        project.season = clean(values.season) ? Number(values.season) : '';
        project.totalEpisodes = clean(values.totalEpisodes) ? Number(values.totalEpisodes) : '';
        project.episodes = [{ ...clone(originalEpisode || {}), number: episode, title: clean(values.episodeTitle), duration: project.duration, airdate: project.airdate }];
      }
      const cues = group.flatMap(source => draft.units[source].cues.map(cue => ({ ...clone(cue), episode })));
      const works = clone(draft.works.filter(work => cues.some(cue => cue.workId === work.id)));
      outputs.push({ project, episode, cues, works, sourceEpisodes: group.map(source => draft.units[source].episode) });
    }
    if (draft.type === 'Series' && new Set(outputs.map(output => output.episode)).size !== outputs.length) errors.push('Two selected source episodes have the same export episode number. Give each one a different number.');
    if (draft.type === 'Series') outputs.sort((a, b) => a.episode - b.episode);
    return { outputs, errors: [...new Set(errors)] };
  }

  function createCueExportDialog(ctx) {
    let active = null, serial = 0;
    const document = root.document;
    const host = () => active ? document.querySelector('[data-cue-export-dialog="' + active.token + '"]') : null;
    function scopeView(draft) {
      if (draft.units.length < 2) return '';
      return `<fieldset class="ced-fields ced-scope" ${draft.busy ? 'disabled' : ''}><div class="field"><label for="ced-scope">Export scope</label><select id="ced-scope" class="input" data-ced-scope><option value="single" ${draft.scope === 'single' ? 'selected' : ''}>One episode</option><option value="range" ${draft.scope === 'range' ? 'selected' : ''}>Episode range</option><option value="all" ${draft.scope === 'all' ? 'selected' : ''}>All ${draft.units.length} episodes</option></select></div>${draft.scope === 'range' ? ['From', 'To'].map(label => `<div class="field"><label for="ced-range-${label}">${label} episode</label><select id="ced-range-${label}" class="input" data-ced-range="${label}">${[...draft.units].sort((a,b)=>Number(a.episode)-Number(b.episode)).map(unit => `<option value="${escape(unit.episode)}" ${Number(unit.episode) === Number(draft['range' + label]) ? 'selected' : ''}>Episode ${escape(episodeLabel(unit.episode))}</option>`).join('')}</select></div>`).join('') : ''}${draft.scope === 'single' ? `<div class="field"><label for="ced-source">Episode</label><select id="ced-source" class="input" data-ced-source>${draft.units.map((unit, index) => `<option value="${index}" ${draft.selected === index ? 'selected' : ''}>Episode ${episodeLabel(unit.episode)} · ${unit.cues.length} cues</option>`).join('')}</select></div>` : `<p>One Excel file per selected society, with a separate sheet for each episode. Each sheet uses the saved production details for that episode.</p>`}</fieldset>`;
    }

    function render() {
      if (!active) return;
      const draft = active, movie = draft.type === 'Movie';
      const indices = selectedIndices(draft), cues = indices.flatMap(index => draft.units[index].cues);
      const content = movie ? 'Movie' : draft.scope !== 'single' ? indices.length + ' episodes' : 'Episode ' + episodeLabel(draft.units[draft.selected].episode);
      const range = !movie && indices.length > 1;
      const linked = root.CueSocieties.freezeWorks(draft.works.filter(work => cues.some(cue => cue.workId === work.id)), draft.artists);
      const stats = root.CueSocieties.summary({ works: linked, cues }), music = cues.reduce((total, cue) => total + Math.max(0, Number(cue.duration) || 0), 0);
      const available = availableFormats(draft, cues, stats);
      const prepared = prepare(draft), duration = prepared.outputs.reduce((total, output) => total + (root.CueDomain.seconds(output.project.duration) || 0), 0);
      const asEntered = ['PRS', 'ASCAP'].every(society => exportOptions(draft, society).membershipPolicy === 'as-entered-v1');
      const historicalFiltered = ['PRS', 'ASCAP'].some(society => exportOptions(draft, society).membershipPolicy === 'confirmed-members-v1');
      const affiliationMessage = asEntered
        ? 'PRS and ASCAP include all selected cues and contributors. Society names are copied as saved, with NS shown as Non Member; missing contributor details stay blank.'
        : historicalFiltered ? 'This saved PRS / ASCAP export uses its original membership filtering.' : 'This saved PRS / ASCAP export keeps its original recorded affiliations and contributor checks.';
      const metrics = [['Cues', cues.length], ['Songs', linked.length], ['Artists', stats.totalArtists], ['Music duration', root.CueDomain.time(music)], [movie ? 'Movie duration' : range ? 'Episode durations' : 'Episode duration', duration > 0 ? root.CueDomain.time(duration) : 'Not recorded'], ['Music usage', duration > 0 ? (music / duration * 100).toFixed(2) + '%' : 'Not available']];
      ctx.modal(ctx.modalHead('Export cue sheets') + `<div class="modal-body ced-dialog" data-cue-export-dialog="${draft.token}" aria-busy="${draft.busy}"><form data-cue-export-form="${draft.token}"><div class="ced-summary"><span class="ced-eyebrow">AMISHNA MUSIC · ${escape(movie ? 'MOVIE' : 'SERIAL')}</span><strong>${escape(draft.project.title)}</strong><span>${escape(content)} · Ready for society review</span></div><p class="ced-intro">Uses the content type and production details saved in your project.</p>${scopeView(draft)}<section class="ced-preview" aria-label="Export preview"><div class="ced-preview-heading"><h3>Your export, at a glance</h3><span>Original shares preserved</span></div><div class="ced-metrics">${metrics.map(([label,value])=>`<div><span>${label}</span><strong>${escape(value)}</strong></div>`).join('')}</div><div class="ced-membership"><span>${escape(affiliationMessage)}</span><span>IPRS includes its members and contributors marked Non-society.</span></div></section>${draft.errors.length ? `<div class="ced-errors" role="alert"><strong>Check these details</strong><ul>${draft.errors.map(error => `<li>${escape(error)}</li>`).join('')}</ul></div>` : ''}<div class="ced-preview-heading ced-format-heading"><h3>Choose your formats</h3><span>Download one or select several</span></div><div class="ced-downloads">${societies.map(society => `<section class="ced-format-card ${draft.societies.includes(society)?'selected':''}"><label class="ced-format-choice"><input type="checkbox" data-ced-select="${society}" ${draft.societies.includes(society)?'checked':''} ${draft.busy || !available[society].cues ? 'disabled' : ''}><strong>${society}</strong></label><p>${available[society].cues} cues · ${available[society].songs} songs</p><button type="button" class="btn" data-ced-format="${society}" ${draft.busy || !available[society].cues ? 'disabled' : ''}>Download Excel</button></section>`).join('')}</div><p class="ced-footnote">Saved ownership shares are never redistributed.</p>${draft.busy?`<div class="ced-progress" role="status"><span></span>${escape(draft.progress || 'Preparing your files…')}</div>`:''}<div class="panel-actions ced-actions"><button type="button" class="btn" data-ced-action="cancel" ${draft.busy ? 'disabled' : ''}>Cancel</button><button class="btn primary" type="submit" ${draft.busy || !draft.societies.length ? 'disabled' : ''}>${draft.busy ? 'Generating export…' : 'Generate export' + (draft.societies.length > 1 ? ' · ' + draft.societies.length + ' formats' : '')}</button></div></form></div>`);
      const modal = host()?.closest('.modal');
      if (modal) {
        modal.classList.add('ced-modal');
        const close = modal.querySelector('[data-action="close-modal"]');
        if (close) close.disabled = draft.busy;
      }
    }

    function cancel() {
      if (!active || active.busy) return;
      if (ctx.close(true) !== false) active = null;
    }

    async function generate() {
      if (!active || active.busy) return;
      const draft = active, result = prepare(draft), errors = [...result.errors];
      if (!draft.societies.length) errors.push('Select at least one download format.');
      if (!errors.length) for (const output of result.outputs) for (const society of draft.societies) {
        const prefix = society + (output.episode == null ? '' : ' · Episode ' + episodeLabel(output.episode));
        const scoped = root.CueSocieties.scope(output.cues, output.works, society, draft.artists, exportOptions(draft, society));
        if (!scoped.cues.length) { errors.push(prefix + (['as-entered-v1', 'recorded-affiliations-v1'].includes(exportOptions(draft, society).membershipPolicy) ? ': No cues are available. Add cues before exporting.' : ': No cues have confirmed ' + society + ' rights holders. Review the artist memberships or choose another format.')); continue; }
        for (const issue of root.CueDomain.validateExport(scoped.cues, output.works, society, output.project, exportOptions(draft, society))) errors.push(prefix + ': ' + issue.message);
      }
      draft.errors = [...new Set(errors)];
      if (draft.errors.length) { render(); return; }
      draft.busy = true;
      render();
      const separateFiles = draft.scope === 'range' || draft.preferences.downloadBehavior === 'files';
      const currentSession = () => active === draft && Boolean(host());
      try {
        const records = [], files = [], usedNames = new Set(), stamp = new Date().toISOString();
        const first = result.outputs[0], multipleEpisodes = draft.type === 'Series' && result.outputs.length > 1;
        const numbers = result.outputs.map(output => output.episode).filter(number => number != null);
        const allCues = result.outputs.flatMap(output => output.cues);
        const frozenWorks = root.CueSocieties.freezeWorks(draft.works.filter(work => allCues.some(cue => cue.workId === work.id)), draft.artists);
        for (const society of draft.societies) {
          const options = exportOptions(draft, society);
          const scoped = root.CueSocieties.scope(allCues, frozenWorks, society, [], options);
          const outputs = result.outputs.map(output => ({ ...output, ...root.CueSocieties.scope(output.cues, frozenWorks.filter(work => output.works.some(included => included.id === work.id)), society, [], options) }));
          const filename = root.CueExportFilename(first.project, first.episode, society, { separator: draft.preferences.filenameSeparator, ...(multipleEpisodes ? { endEpisode: numbers.at(-1) } : {}) });
          if (usedNames.has(filename)) throw new Error('Two exports have the same filename. Use different episode numbers.');
          usedNames.add(filename);
          draft.progress = 'Generating ' + society + ' · file ' + (files.length + 1) + ' of ' + draft.societies.length + (multipleEpisodes ? ' · ' + outputs.length + ' episode sheets' : '');
          render();
          const binary = multipleEpisodes
            ? await root.CueExports.buildEpisodesFormatted(society, outputs, [], options)
            : await root.CueExports.buildFormatted(society, first.project, first.episode, scoped.cues, scoped.works, [], options);
          if (!currentSession()) return;
          files.push({ filename, binary });
          records.push({
            id: 'EXP-' + (root.crypto?.randomUUID?.() || Date.now().toString(36) + '-' + Math.random().toString(36).slice(2)),
            clientId: first.project.clientId, projectId: first.project.id, projectTitle: first.project.title,
            episode: first.episode, ...(multipleEpisodes ? { episodes: numbers } : {}), society, filename, count: scoped.cues.length,
            version: (root.CueExports.mappingFor?.(society, first.project) || root.CueExports.mappings[society]).version,
            date: stamp, status: 'Formatted Excel', sourceEpisodes: result.outputs.flatMap(output => output.sourceEpisodes),
            membershipSummary: clone(scoped.summary),
            snapshot: {
              project: clone(first.project), cues: clone(scoped.cues),
              works: clone(frozenWorks.filter(work => scoped.works.some(included => included.id === work.id))), membershipPolicy: options.membershipPolicy,
              ...(multipleEpisodes ? { episodes: outputs.map(output => ({ episode: output.episode, project: clone(output.project) })) } : {}),
            },
          });
        }
        let content = files[0].binary, filename = files[0].filename, mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        if (files.length > 1 && !separateFiles) {
          const zip = new root.JSZip();
          for (const file of files) zip.file(file.filename, file.binary);
          content = await zip.generateAsync({ type: 'uint8array' });
          filename = root.CueExportFilename(result.outputs[0].project, numbers[0] ?? null, undefined, { extension: 'zip', separator: draft.preferences.filenameSeparator, ...(numbers.length > 1 ? { endEpisode: numbers.at(-1) } : {}) });
          mime = 'application/zip';
        }
        if (!currentSession()) return;
        const saved = await ctx.commit('Exported ' + records.length + ' cue sheet' + (records.length === 1 ? '' : 's') + ' · ' + result.outputs[0].project.title, workspace => {
          workspace.exports ||= [];
          workspace.exports.unshift(...records);
        });
        if (!saved) {
          draft.errors = ['Export history could not be saved. Please try downloading again.'];
          return;
        }
        if (!currentSession()) return;
        if (files.length > 1 && separateFiles) {
          for (const file of files) await ctx.download(file.binary, file.filename, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        } else await ctx.download(content, filename, mime);
        if (currentSession()) ctx.close(true);
        if (active === draft) active = null;
        ctx.toast(files.length > 1 && separateFiles ? files.length + ' Excel files downloaded.' : files.length > 1 ? 'Cue sheets downloaded in ' + filename : filename + ' downloaded.');
      } catch (error) {
        draft.errors = ['Export could not be completed: ' + (error?.message || 'Please try again.')];
        ctx.toast(draft.errors[0]);
      } finally {
        draft.busy = false;
        if (active === draft) {
          if (host()) render();
          else active = null;
        }
      }
    }

    document.addEventListener('submit', event => {
      if (!active || event.target.dataset.cueExportForm !== active.token || !host()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (active.busy) return;
      void generate();
    }, true);
    document.addEventListener('click', event => {
      const element = host();
      if (!active || !element) return;
      const action = event.target.closest('[data-ced-action]');
      const format = event.target.closest('[data-ced-format]');
      const close = event.target.closest('[data-action="close-modal"]');
      if (!action && !format && !(close && element.closest('.modal')?.contains(close))) return;
      if ((action && !element.contains(action)) || (format && !element.contains(format))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (active.busy) return;
      if (close || action?.dataset.cedAction === 'cancel') cancel();
      else if (format && societies.includes(format.dataset.cedFormat)) { active.societies = [format.dataset.cedFormat]; void generate(); }
    }, true);
    document.addEventListener('change', event => {
      const element = host(), input = event.target;
      if (!active || active.busy || !element?.contains(input)) return;
      if (input.matches('[data-ced-scope]')) { active.scope = ['all', 'range'].includes(input.value) ? input.value : 'single'; active.errors = []; render(); }
      else if (input.matches('[data-ced-range]')) { active['range' + input.dataset.cedRange] = Number(input.value); active.errors = []; render(); }
      else if (input.matches('[data-ced-source]')) { active.selected = Number(input.value); active.errors = []; render(); }
      else if (input.matches('[data-ced-select]') && societies.includes(input.dataset.cedSelect)) { active.societies = input.checked ? [...new Set([...active.societies, input.dataset.cedSelect])] : active.societies.filter(society => society !== input.dataset.cedSelect); active.errors = []; render(); }
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || !active || !host()) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!active.busy) cancel();
    }, true);

    return {
      isBusy: () => !!active?.busy,
      open(options) {
        if (active?.busy) return false;
        if (!options?.project) { ctx.toast('Choose a project to export.'); return false; }
        const preferences = ctx.state?.()?.preferences?.exportDefaults || {};
        active = createDraft({ ...options, artists: options.artists || ctx.state?.()?.artists || [], preferences });
        const cues = active.scope === 'all' ? active.units.flatMap(unit => unit.cues) : active.units[active.selected].cues;
        const stats = root.CueSocieties.summary({ works: root.CueSocieties.freezeWorks(active.works.filter(work => cues.some(cue => cue.workId === work.id)), active.artists), cues });
        const available = availableFormats(active, cues, stats);
        active.societies = (Array.isArray(preferences.formats) ? preferences.formats : societies).filter(society => societies.includes(society) && available[society].cues > 0);
        active.token = String(++serial);
        render();
        return true;
      },
    };
  }

  root.createCueExportDialog = createCueExportDialog;
  if (typeof module !== 'undefined' && module.exports) module.exports = { createCueExportDialog, createDraft, valuesFor, setValue, prepare };
})(typeof window !== 'undefined' ? window : globalThis);
