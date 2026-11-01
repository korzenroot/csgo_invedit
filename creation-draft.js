// Shared page-session preferences. Catalogue templates remain immutable.
export class CreationPreferences {
  constructor() {
    this.wear = null;
    this.seed = '0';
    this.statTrak = false;
    this.counter = '0';
    this.stickers = ['', '', '', '', ''];
  }

  commitWear(text) {
    const value = Number(text);
    if (String(text).trim() !== '' && Number.isFinite(value)) this.wear = String(value);
  }

  build(catalog, key) {
    const record = catalog.records.get(key);
    const item = catalog.template(key, Boolean(record?.statTrakTemplate && this.statTrak));
    const attrs = new Map(item.attributes.map(a => [a.defIndex, a]));
    const set = (id, value) => {
      if (attrs.has(id)) attrs.get(id).value = String(value);
      else item.attributes.push({ defIndex: id, value: String(value) });
    };
    const numeric = (text, label, min, max, integer = false) => {
      const value = Number(text);
      if (String(text).trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new Error(`${label} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}.`);
      }
      return value;
    };
    const paint = catalog.data.paintKits?.find(k => k.id === Number(attrs.get(6)?.value));
    const painted = attrs.has(7) && attrs.has(8);
    const min = record.wearMin ?? paint?.wearMin;
    let wear = null;
    if (painted) {
      if (!Number.isFinite(min)) throw new Error('Paint wear limits are unavailable.');
      wear = this.wear ?? min;
      set(8, wear);
      set(7, numeric(this.seed, 'Paint seed', 0, 1000, true));
    }
    const statTrak = attrs.has(80);
    if (statTrak) set(80, numeric(this.counter, 'StatTrak counter', 0, 0xffffffff, true));
    const slots = catalog.definitions.get(record.defIndex)?.stickerSlots?.length ?? 0;
    for (let slot = 0; slot < slots; slot++) {
      const text = this.stickers[slot].trim();
      if (!text) continue;
      const id = /^\d+$/.test(text) ? text : /\((\d+)\)$/.exec(text)?.[1];
      if (!id) throw new Error(`Sticker ${slot + 1}: pick a sticker from the list or enter its ID.`);
      set(113 + slot * 4, id);
      set(114 + slot * 4, 0);
    }
    return { item, painted, min, wear, statTrak, slots };
  }
}
