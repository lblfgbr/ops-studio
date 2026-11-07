import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudio, studioPage } from './helpers/studio-harness.mjs';

async function setup(t, route, options = {}) {
  const studio = await createStudio({ route, ...options });
  t.after(() => {
    studio.close();
    assert.deepEqual(studio.errors, [], 'The production page has no runtime errors');
  });
  return studio;
}

const writes = requests => requests.filter(request => !['GET', 'HEAD'].includes(request.method));

test('studio automation overview keeps loaded metrics, period requests and expandable statistics', async t => {
  const { d, requests, find, click, input } = await setup(t, 'automation');
  const metrics = [...d.querySelectorAll('.ov-secondary .review-metric')];
  assert.equal(metrics.length, 4);
  assert.doesNotMatch(find('.governance-dashboard').textContent, /undefined|NaN/);
  for (const metric of metrics) {
    assert.ok(metric.querySelector(':scope>span').textContent.trim());
    assert.ok(metric.querySelector(':scope>small').textContent.trim());
    const value = metric.querySelector(':scope>strong');
    if (value.textContent === '暂无数据') {
      assert.ok(value.classList.contains('ax-metric-empty'));
    } else {
      assert.match(value.querySelector('.ax-metric-number').textContent, /^\d+(\.\d+)?$/);
      assert.match(value.querySelector('.ax-metric-unit').textContent, /%|分钟/);
    }
  }
  for (const outcome of ['fixed', 'added', 'waiting']) {
    assert.match(find('[data-overview-outcome="' + outcome + '"]>strong').textContent, /^\d+$/);
  }
  const before = requests.length;
  await input('#review-period', '7', 'change');
  assert.equal(requests.slice(before).filter(request => request.url === '/api/automation/effectiveness?days=7').length, 1);
  await click('.review-stat-detail summary');
  assert.ok(find('.review-stat-detail').open);
  const refreshStart = requests.length;
  await click('.ov-secondary [data-review-refresh]');
  assert.equal(requests.slice(refreshStart).filter(request => request.url === '/api/automation/effectiveness?days=7').length, 1);
  assert.ok(find('.review-stat-detail').open, 'Refresh preserves the original statistics disclosure state');
  assert.equal(writes(requests).length, 0);
});

test('studio record cards retain selection, action confirmation and accessible menu dismissal', async t => {
  const { w, d, requests, find, click, wait } = await setup(t, 'automation/tasks');
  assert.equal(d.querySelectorAll('[data-record-select-all]').length, 1);
  assert.ok(find('.ax-select-all [data-record-select-all]'));
  assert.ok([...d.querySelectorAll('.ax-record-cards tbody td')].every(cell => cell.dataset.label));
  await click('.ax-select-all [data-record-select-all]');
  assert.ok([...d.querySelectorAll('[data-record-select]')].every(checkbox => checkbox.checked));
  assert.equal(find('[data-cleanup-records]').disabled, false);
  await click('[data-record-select]');
  assert.equal(find('[data-record-select-all]').indeterminate, true);
  await click('[data-record-select-all]');
  await click('[data-record-select-all]');
  assert.equal(find('[data-cleanup-records]').disabled, true);

  assert.equal(d.querySelector('.ux-row-more'), null);
  await click('[data-delete-record]');
  assert.ok(find('.studio-confirm-dialog'));
  assert.equal(writes(requests).length, 0, 'Moving a delete action does not skip its original confirmation');
  await click('[data-studio-cancel]');
  assert.equal(d.querySelector('.studio-confirm-dialog'), null);
  assert.equal(writes(requests).length, 0);
});

test('studio schedule cards retain all fields, mutually exclusive menus and one revision-checked write', async t => {
  const { d, requests, find, click, wait } = await setup(t, 'automation/schedules');
  const row = find('.ax-record-cards tbody tr');
  assert.deepEqual([...row.cells].map(cell => cell.dataset.label), ['任务名称 / 工具', '版本范围', '执行频率', '状态', '下次执行', '最近结果', '操作']);
  assert.ok(row.querySelector('[data-schedule-edit]'));
  assert.ok(row.querySelector('[data-schedule-run]'));
  assert.ok(row.querySelector('[data-schedule-runs]'));
  const menus = [...d.querySelectorAll('.ux-row-more')];
  assert.ok(menus.length > 1);
  menus[0].querySelector('summary').click();
  await wait();
  menus[1].querySelector('summary').click();
  await wait();
  assert.equal(d.querySelectorAll('.ux-row-more[open]').length, 1);
  assert.equal(menus[0].open, false);
  const toggle = find('.ux-row-more[open] [data-schedule-toggle]');
  const id = toggle.dataset.scheduleToggle;
  const wasEnabled = toggle.textContent.trim() === '暂停';
  await click('.ux-row-more[open] [data-schedule-toggle]');
  const updates = requests.filter(request => request.path === '/api/automation/schedules/' + id && request.method === 'PATCH');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].body.enabled, !wasEnabled);
  assert.equal(typeof updates[0].body.revision, 'number');
  assert.equal(find('[data-schedule-toggle="' + id + '"]').textContent.trim(), wasEnabled ? '启用' : '暂停');
  await click('[data-schedule-edit="' + id + '"]');
  assert.ok(find('.qw-drawer [data-sched-field="name"]'));
  await click('[data-qw-close]');
  assert.equal(writes(requests).length, 1);
});

test('studio quality preparation summary reflects live inputs without changing the submitted query', async t => {
  const { requests, find, click, input } = await setup(t, 'automation/quality');
  await input('[data-q-field="domain"]', 'Platform');
  await input('[data-q-field="date"]', '2026-10-12');
  assert.match(find('.ux-preparation-copy small').textContent, /Platform/);
  assert.match(find('.ux-preparation-copy small').textContent, /2026-10-12/);
  const apiKind = find('[data-q-kind="api"]');
  assert.equal(apiKind.checked, true);
  await click('[data-q-kind="api"]');
  assert.doesNotMatch(find('.ux-preparation-copy small').textContent, /APITest/);
  await click('[data-q-fetch]');
  const submissions = requests.filter(request => request.path === '/api/quality/jobs' && request.method === 'POST');
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].body.domain, 'Platform');
  assert.equal(submissions[0].body.date, '2026-10-12');
  assert.equal(submissions[0].body.kinds.includes('api'), false);
  assert.ok(submissions[0].body.versions.length > 0);
  assert.ok(find('.ax-table-hint'));
  assert.equal(find('.qw-table-wrap').getAttribute('tabindex'), '0');
  await click('[data-qw-tab="static"]');
  assert.equal(find('[data-qw-tab="static"]').getAttribute('aria-pressed'), 'true');
  assert.equal(writes(requests).length, 1);
});

test('studio UT task exposes delete directly and retains original confirmation', async t => {
  const { w, d, requests, find, click, wait } = await setup(t, 'automation/tasks');
  let top=320;
  w.scrollTo=(x,y)=>{top=y};
  w.eval("navUi.scroll.set('#/automation/tasks',320)");
  await click('[data-governance-detail]');
  assert.equal(top,0,'Opening a task starts at the top instead of restoring the records offset');
  const header = find('.ut-task-detail-head');
  assert.equal(d.querySelector('.ut-task-more'), null);
  await click('.ut-task-detail-head [data-auto-ut-delete]');
  assert.ok(find('.studio-confirm-dialog'));
  assert.equal(writes(requests).length, 0);
  await click('[data-studio-cancel]');
  assert.ok(find('.ut-task-detail-head'));
});

test('studio settings directory and original configuration drawer remain usable without IntersectionObserver', async t => {
  const { d, requests, find, click, wait } = await setup(t, 'automation/settings');
  const sections = [...d.querySelectorAll('.ux-section-nav [data-ux-section]')];
  assert.ok(sections.length >= 3);
  assert.equal(sections[0].getAttribute('aria-current'), 'location');
  sections[1].click();
  await wait();
  assert.equal(sections[1].getAttribute('aria-current'), 'location');
  assert.equal(d.querySelectorAll('.ux-section-nav [aria-current="location"]').length, 1);
  await click('[data-qw-drawer="codehub"]');
  assert.ok(find('.qw-drawer'));
  await click('[data-qw-close]');
  assert.equal(d.querySelector('.qw-drawer'), null);
  assert.equal(writes(requests).length, 0);
});

test('automation navigation keeps header and sidebar typography stable while UT and records retain content fonts', async t => {
  const { w, d, find, route } = await setup(t, 'automation');
  const html = await studioPage({ styles: true });
  for (const match of html.matchAll(/<style>([\s\S]*?)<\/style>/g)) {
    const style = d.createElement('style');
    style.textContent = match[1];
    d.head.append(style);
  }
  const typography = selector => {
    const style = w.getComputedStyle(find(selector));
    return [style.fontFamily, style.fontSize, style.fontWeight, style.lineHeight];
  };
  const chrome = ['.studio-topbar .pr-brand strong', '.studio-topbar .pr-global button',
    '.variant-a-sidebar .variant-a-nav [data-automation-nav="schedules"]', '.variant-a-sidebar .ux-space-name'];
  const baseline = chrome.map(typography);
  for (const page of ['automation/auto-ut', 'automation/tasks', 'automation/group-mr', 'automation/quality', 'automation']) {
    await route(page);
    assert.deepEqual(chrome.map(typography), baseline, 'Shared navigation typography changed on ' + page);
    if (['automation/auto-ut', 'automation/tasks'].includes(page)) {
      const content = typography('.variant-a-main');
      assert.match(content[0], /Segoe UI/);
      assert.equal(content[1], '14px');
      assert.equal(content[3], '1.6');
    }
    if (page === 'automation/auto-ut') assert.equal(typography('.variant-a-main button')[1], '13px');
  }
});
