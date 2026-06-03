  async sanitizeValues(model, values, sheet, context = 'write') {
    const resolvedValues = await this.resolveExternalIdHelperColumns(model, values, sheet);
    const cleaned = compactObject(resolvedValues);
    const fields = await this.getModelFields(model);
    const virtual = this.cache.virtualFields.get(model) || new Map();
    const out = {};

    for (const [field, value] of Object.entries(cleaned)) {
      const def = fields[field] || virtual.get(field);

      if (!def) {
        this.log.warn(sheet, `Field dilewati karena tidak ada di ${model}: ${field}`);
        continue;
      }

      if (!this.dryRun && this.isDryId(value)) {
        this.log.warn(sheet, `Field ${model}.${field} dilewati karena masih virtual dry-run.`);
        continue;
      }

      if (def.readonly && context === 'write' && field !== 'id') {
        this.log.warn(sheet, `Field readonly dilewati: ${model}.${field}`);
        continue;
      }

      if (def.type === 'selection' && !isBlank(value)) {
        const allowed = Array.isArray(def.selection)
          ? def.selection.map((x) => Array.isArray(x) ? String(x[0]) : String(x))
          : [];

        if (allowed.length) {
          const safe = this.selectionAliases(model, field, value, allowed);
          if (!safe) {
            this.log.warn(
              sheet,
              `Nilai selection tidak valid dan dilewati: ${model}.${field}='${value}'. Pilihan valid: ${allowed.join(', ')}`
            );
            continue;
          }

          if (String(value) !== String(safe)) {
            this.log.warn(sheet, `Selection disesuaikan: ${model}.${field} '${value}' -> '${safe}'`);
          }

          out[field] = safe;
          continue;
        }
      }

      out[field] = value;
    }

    return out;
  }
