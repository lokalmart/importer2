  inferRealFieldFromExternalIdHelper(field, fields, virtual) {
    const name = String(field || '').trim();

    if (name.endsWith('_ids_external_id')) {
      const real = name.replace(/_external_id$/, '');
      return fields[real] || virtual?.has(real) ? real : real;
    }

    if (name.endsWith('_id_external_id')) {
      const real = name.replace(/_external_id$/, '');
      return fields[real] || virtual?.has(real) ? real : real;
    }

    if (name.endsWith('_external_ids')) {
      const base = name.replace(/_external_ids$/, '');
      const candidates = [`${base}_ids`, base];
      return candidates.find((x) => fields[x] || virtual?.has(x)) || `${base}_ids`;
    }

    if (name.endsWith('_external_id')) {
      const base = name.replace(/_external_id$/, '');
      const candidates = [base, `${base}_id`, `${base}_ids`];
      return candidates.find((x) => fields[x] || virtual?.has(x)) || base;
    }

    return null;
  }

  isExternalIdHelperField(field) {
    const name = String(field || '').trim();
    if (name === '_external_id') return false;
    return (
      name.endsWith('_external_id') ||
      name.endsWith('_external_ids')
    );
  }

  async resolveExternalIdHelperValue(model, realField, rawValue, def, sheet, helperField) {
    if (isBlank(rawValue)) return undefined;

    const relationModel = def?.relation || null;

    if (def?.type === 'many2one') {
      const id = await this.resolveXmlId(rawValue, relationModel);
      if (!id) {
        if (this.dryRun) {
          const dry = this.makeDryId(relationModel || 'unknown.model', rawValue);
          this.cacheXmlId(rawValue, relationModel || 'unknown.model', dry);
          this.log.warn(sheet, `[dry-run] External ID belum ada, disimulasikan: ${helperField}=${rawValue} -> ${realField}`);
          return dry;
        }
        this.log.warn(sheet, `External ID tidak ditemukan dan relasi dikosongkan: ${helperField}=${rawValue} -> ${realField}`);
        return undefined;
      }
      return id;
    }

    if (def?.type === 'many2many' || def?.type === 'one2many') {
      const ids = [];
      for (const xmlid of parseListCell(rawValue)) {
        const id = await this.resolveXmlId(xmlid, relationModel);
        if (id) {
          ids.push(id);
        } else if (this.dryRun) {
          const dry = this.makeDryId(relationModel || 'unknown.model', xmlid);
          this.cacheXmlId(xmlid, relationModel || 'unknown.model', dry);
          ids.push(dry);
          this.log.warn(sheet, `[dry-run] External ID M2M/O2M belum ada, disimulasikan: ${xmlid}`);
        } else {
          this.log.warn(sheet, `External ID M2M/O2M tidak ditemukan: ${xmlid}`);
        }
      }
      return ids.length ? [[6, 0, ids]] : undefined;
    }

    this.log.warn(
      sheet,
      `Kolom helper external_id dilewati karena field tujuan bukan relasi: ${helperField} -> ${model}.${realField}`
    );
    return undefined;
  }

  async resolveExternalIdHelperColumns(model, values, sheet) {
    const cleaned = compactObject(values);
    const fields = await this.getModelFields(model);
    const virtual = this.cache.virtualFields.get(model) || new Map();
    const out = {};

    for (const [field, value] of Object.entries(cleaned)) {
      if (!this.isExternalIdHelperField(field)) {
        out[field] = value;
        continue;
      }

      const realField = this.inferRealFieldFromExternalIdHelper(field, fields, virtual);
      const def = fields[realField] || virtual.get(realField);

      if (!def) {
        this.log.warn(
          sheet,
          `Kolom helper external_id dilewati karena field tujuan tidak ada di ${model}: ${field} -> ${realField}`
        );
        continue;
      }

      const resolved = await this.resolveExternalIdHelperValue(model, realField, value, def, sheet, field);
      if (resolved !== undefined && resolved !== null && resolved !== '') {
        out[realField] = resolved;
        this.log.info(sheet, `External ID resolved: ${field} -> ${realField}`);
      }
    }

    return out;
  }
