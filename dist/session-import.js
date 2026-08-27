export async function applyTamaSaveImport(Slots, decoded, { confirmReplace } = {}) {
    const match = await Slots.findByLineage(decoded.lineage);
    const incoming = Number(decoded.revision);
    if (!match) {
        const id = await Slots.create({ name: 'imported', device: decoded.device,
            flash: decoded.flash, ram: decoded.ram, session: decoded.session,
            lineage: decoded.lineage, revision: incoming, savedUtcMs: Number(decoded.savedUtcMs),
            lastExportedRevision: incoming });
        return { action: 'created', id };
    }
    if (incoming <= match.meta.revision) {
        let yes = false;
        try { yes = !!await confirmReplace?.({ incoming, current: match.meta.revision,
            incomingSavedUtcMs: decoded.savedUtcMs, currentSavedUtcMs: match.meta.savedUtcMs }); } catch {}
        if (!yes) return { action: 'cancelled', id: match.meta.id };
    }
    await Slots.update(match.meta.id, { flash: decoded.flash, ram: decoded.ram,
        session: decoded.session, revision: incoming, savedUtcMs: Number(decoded.savedUtcMs),
        lastExportedRevision: incoming });
    return { action: 'replaced', id: match.meta.id };
}
