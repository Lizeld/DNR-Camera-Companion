/**
 * "Parting out" picker on the Shoot tab: the donor car the parts being shot
 * come from. Picked once per car; each part is stamped with it when its label
 * is read (orchestrator FLUSH) and Inventory links the part to the car — which
 * the listing titles (year/make/model) and the donor reports need.
 */

import { $, on, text } from './dom.js';
import * as settings from '../core/settings.js';
import * as inventory from '../app/inventory.js';

let loading = false;

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

const carLabel = (c) => `${c.name}${c.vin6 ? ` …${c.vin6}` : ''}${c.parts ? ` · ${c.parts} part${c.parts === 1 ? '' : 's'}` : ''}`;

function renderHint(s = settings.load()) {
  text(
    $('#donor-hint'),
    s.donorCarId ? 'New parts are linked to this car.' : 'Pick the car these parts come from — titles and reports need it.',
  );
}

async function refresh() {
  const select = $('#donor-car');
  if (!select || loading) return;
  loading = true;
  try {
    const s = settings.load();
    const cars = await inventory.listCars();
    const keep = [option('', 'No donor car (mixed parts)')];
    if (cars) {
      for (const c of cars) keep.push(option(c.id, carLabel(c)));
    }
    // The saved car stays selectable even when the list can't be loaded or no longer has it.
    if (s.donorCarId && !keep.some((o) => o.value === s.donorCarId)) {
      keep.push(option(s.donorCarId, s.donorCarName || `Car ${s.donorCarId}`));
    }
    select.replaceChildren(...keep);
    select.value = s.donorCarId;
    if (!cars) text($('#donor-hint'), 'Car list unavailable — Inventory is unreachable or not updated yet.');
    else renderHint(s);
  } finally {
    loading = false;
  }
}

export function initDonor() {
  const select = $('#donor-car');
  if (!select) return;
  on(select, 'change', () => {
    const chosen = select.selectedOptions[0];
    settings.save({
      donorCarId: select.value,
      donorCarName: select.value ? chosen?.textContent.replace(/ · \d+ parts?$/, '') ?? '' : '',
    });
    renderHint();
  });
  // Cars are added in Inventory while shooting: reload the list when the picker is opened.
  on(select, 'pointerdown', () => void refresh());
  on(select, 'focus', () => void refresh());
  // A different Inventory site or token has different cars.
  let backend = `${settings.load().backendUrl}|${settings.load().backendToken}`;
  settings.onChange((s) => {
    const now = `${s.backendUrl}|${s.backendToken}`;
    if (now !== backend) {
      backend = now;
      void refresh();
    }
  });
  void refresh();
}
