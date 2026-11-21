const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const html = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
const sourceBetween = (start, end) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)));

function load(orders = []){
  const context = vm.createContext({
    Date, Number, String, Array, Promise,
    db:null, ordMem:orders,
    key:value => String(value || '').trim().toLowerCase(),
    calc:order => ({amt:order.amount}),
    retailerPhone:order => order.phone || '',
    startOfDay:() => new Date(2026, 10, 21).getTime()
  });
  vm.runInContext(
    sourceBetween('  const dateValue =', '  if(F.p === \'custom\'') +
    sourceBetween('  function periodRange(', '  function saveFilters(') +
    sourceBetween('  function oQuery(', '  async function migrateLegacy('),
    context
  );
  return context;
}

test('custom dates include the full final day and exclude the following midnight', async () => {
  const c = load([
    {id:'1', createdAt:new Date(2026, 10, 1).getTime(), amount:10},
    {id:'2', createdAt:new Date(2026, 10, 21, 23, 59, 59, 999).getTime(), amount:20},
    {id:'3', createdAt:new Date(2026, 10, 22).getTime(), amount:30}
  ]);
  const range = c.periodRange({p:'custom', from:'2026-11-01', to:'2026-11-21'});
  const result = await c.oQuery({...range, statuses:[], sort:'newest'}, 30);
  assert.equal(result.total, 2);
  assert.equal(result.sum, 30);
  assert.deepEqual(Array.from(result.items, o => o.id), ['2', '1']);
  assert.equal(c.parseDate('2026-02-30'), null);
});

test('calendar presets handle month/year transitions and daylight saving', () => {
  const c = load();
  for(const [p, expected] of [
    ['today', [new Date(2026, 10, 21), new Date(2026, 10, 22)]],
    ['yesterday', [new Date(2026, 10, 20), new Date(2026, 10, 21)]],
    ['7', [new Date(2026, 10, 15), new Date(2026, 10, 22)]],
    ['30', [new Date(2026, 9, 23), new Date(2026, 10, 22)]],
    ['month', [new Date(2026, 10, 1), new Date(2026, 11, 1)]],
    ['lastMonth', [new Date(2026, 9, 1), new Date(2026, 10, 1)]]
  ]){
    const range = c.periodRange({p});
    assert.equal(range.since, expected[0].getTime());
    assert.equal(range.until, expected[1].getTime());
  }
  c.startOfDay = () => new Date(2027, 0, 5).getTime();
  assert.equal(c.periodRange({p:'lastMonth'}).since, new Date(2026, 11, 1).getTime());
  c.startOfDay = () => new Date(2026, 2, 10).getTime();
  assert.equal(c.periodRange({p:'7'}).since, new Date(2026, 2, 4).getTime());
});

test('combined filters restrict ownership, retailer, status, sync and search', async () => {
  const base = {createdAt:100, retailer:'ABC', status:'Sent', sync:'pending', by:{short:'A', name:'Alice'}, no:'ORD-1', amount:10};
  const c = load([
    {...base, id:'match'}, {...base, id:'other-user', by:{short:'B'}},
    {...base, id:'other-retailer', retailer:'ABCD'}, {...base, id:'other-status', status:'Saved'},
    {...base, id:'other-sync', sync:'synced'}
  ]);
  const result = await c.oQuery({since:0, until:Infinity, short:'A', retailer:'abc',
    statuses:['Sent', 'Edited'], sync:'pending', q:'alice', sort:'newest'}, 30);
  assert.deepEqual(Array.from(result.items, o => o.id), ['match']);
});

test('sort applies before pagination, and cancelled amounts stay out of the total', async () => {
  const c = load([
    {id:'a', createdAt:100, amount:10, status:'Saved'},
    {id:'b', createdAt:200, amount:50, status:'Cancelled'},
    {id:'c', createdAt:300, amount:30, status:'Sent'}
  ]);
  const f = {since:0, until:Infinity, statuses:[]};
  for(const [sort, ids] of [['newest', ['c', 'b']], ['oldest', ['a', 'b']],
    ['amountDesc', ['b', 'c']], ['amountAsc', ['a', 'c']]]){
    const result = await c.oQuery({...f, sort}, 2);
    assert.deepEqual(Array.from(result.items, o => o.id), ids);
    assert.equal(result.total, 3);
    assert.equal(result.sum, 40);
    assert.equal(result.more, true);
  }
});

test('search opens on demand and closing clears the hidden query', () => {
  const nodes = Object.fromEntries(['bookSearchRow', 'bookSearch', 'searchToggle'].map(id => [id, {
    hidden:true, value:'', attributes:{}, focused:false,
    setAttribute(name, value){ this.attributes[name] = value; },
    focus(){ this.focused = true; }
  }]));
  const c = vm.createContext({$:id => nodes[id]});
  vm.runInContext(sourceBetween('  function setSearchOpen(', '  function activeFilters('), c);
  c.setSearchOpen(true);
  assert.equal(nodes.bookSearchRow.hidden, false);
  assert.equal(nodes.searchToggle.attributes['aria-expanded'], 'true');
  assert.equal(nodes.bookSearch.focused, true);
  nodes.bookSearch.value = 'test retailer';
  c.setSearchOpen(false);
  assert.equal(nodes.bookSearchRow.hidden, true);
  assert.equal(nodes.bookSearch.value, '');
  assert.equal(nodes.searchToggle.attributes['aria-expanded'], 'false');
  assert.equal(nodes.searchToggle.focused, true);
});
