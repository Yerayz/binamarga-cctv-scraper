"use strict";
(async () => {
  const auth = await fetch('/api/auth').then(r => r.json());
  if (auth.required && (await fetch('/api/health')).status === 401) {
    document.querySelector('.app-shell').hidden = true;
    const panel = document.createElement('section'); panel.className = 'login-panel';
    panel.innerHTML = '<h1>TolWatch</h1><p>Sign in to your camera desk.</p><form id="loginForm"><label>Admin password<input type="password" id="password" required autocomplete="current-password"></label><button class="button record-button">Sign in</button><p id="loginError" role="alert"></p></form>';
    document.body.append(panel);
    document.getElementById('loginForm').onsubmit = async event => {
      event.preventDefault();
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('password').value }) });
      if (response.ok) location.reload(); else document.getElementById('loginError').textContent = (await response.json()).error;
    };
    return;
  }
  document.querySelector('.local-chip').textContent = 'SERVER SESSION';
  document.querySelector('.sidebar-signoff').textContent = 'INDEPENDENT CAMERA DESK · v2.0';
  document.querySelector('.footer > span').textContent = 'TOLWATCH / LIVE CAMERA DESK';
  document.querySelector('.capture-description').textContent = 'Save live footage on the server at original source resolution, without re-encoding.';
  document.querySelector('.recordings-section .section-aside').textContent = 'Stored on server · kept until deleted';
  const section = document.createElement('section'); section.className = 'section automation-section';
  section.innerHTML = `<div class="section-header"><div><div class="section-kicker">AUTOMATED CAPTURE</div><h2>Schedules & continuous archive</h2></div><button id="logout" class="button subtle-button">Sign out</button></div>
    <p>Select a camera above, then add a task. Runs continue with the browser closed while the server is running.</p>
    <form id="taskForm" class="automation-form">
      <label>Task name<input id="taskName" placeholder="Defaults to camera name" maxlength="100"></label>
      <label>Mode<select id="taskMode"><option value="scheduled">Scheduled clip</option><option value="continuous">Continuous archive</option></select></label>
      <label>Clip / segment seconds<input id="taskDuration" type="number" min="10" max="86400" value="300" required></label>
      <label>Cron preset<select id="cronPreset"><option value="0 * * * *">Every hour</option><option value="*/15 * * * *">Every 15 minutes</option><option value="0 8 * * *">Daily at 08:00</option><option value="custom">Custom</option></select></label>
      <label>Cron (scheduled only)<input id="taskCron" value="0 * * * *" required></label>
      <label>Timezone<input id="taskTimezone" value="Asia/Jakarta" required></label>
      <button class="button record-button" id="saveTask">Create task for selected camera</button><button type="button" class="button subtle-button" id="cancelEdit" hidden>Cancel edit</button>
    </form><p id="taskSelection">Select a camera to create a task.</p><div id="taskList" class="recordings-list"></div><details><summary>Execution history</summary><div id="taskEvents"></div></details><p id="storageInfo"></p>`;
  document.querySelector('.recordings-section').before(section);
  const filters = document.createElement('div'); filters.className = 'automation-form';
  filters.innerHTML = '<label>Camera / road<input id="filter-search" type="search"></label><label>Mode<select id="filter-mode"><option value="">All</option><option>manual</option><option>scheduled</option><option>continuous</option></select></label><label>Status<select id="filter-status"><option value="">All</option><option>completed</option><option>recording</option><option>failed</option></select></label><label>Date (WIB)<input type="date" id="filter-date"></label><button class="button subtle-button" id="previousPage">Previous</button><span id="libraryPageLabel"></span><button class="button subtle-button" id="nextPage">Next</button>';
  document.getElementById('recordingsList').before(filters);
  const script = document.createElement('script'); script.src = '/app.js';
  await new Promise(resolve => { script.onload = resolve; document.body.append(script); });
  let tasks = [], editing = null;
  const el = id => document.getElementById(id);
  const request = async (url, method = 'GET', body) => {
    const response = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error); return data;
  };
  const action = fn => async event => { try { await fn(event); } catch (error) { showNotice(error.message); } };
  const reset = () => { editing = null; el('saveTask').textContent = 'Create task for selected camera'; el('cancelEdit').hidden = true; };
  el('cronPreset').onchange = () => { if (el('cronPreset').value !== 'custom') el('taskCron').value = el('cronPreset').value; };
  el('taskMode').onchange = () => { el('taskCron').disabled = el('taskMode').value === 'continuous'; el('cronPreset').disabled = el('taskCron').disabled; };
  el('cancelEdit').onclick = reset;
  el('taskForm').onsubmit = action(async event => {
    event.preventDefault();
    const selected = editing ? tasks.find(t => t.id === editing) : { roadId: state.road?.id, cameraId: state.camera?.id };
    if (!selected?.cameraId) throw new Error('Select a camera first');
    await request(editing ? `/api/tasks/${editing}` : '/api/tasks', editing ? 'PUT' : 'POST', { roadId: selected.roadId, cameraId: selected.cameraId, name: el('taskName').value, mode: el('taskMode').value, duration: Number(el('taskDuration').value), cron: el('taskCron').value, timezone: el('taskTimezone').value });
    reset(); await refresh(); showNotice('Automation saved. Files will be stored on the server.', 'success');
  });
  el('taskList').onclick = action(async event => {
    const button = event.target.closest('[data-task]'); if (!button) return;
    const task = tasks.find(t => t.id === button.dataset.task);
    if (button.dataset.action === 'edit') {
      editing = task.id; el('taskName').value = task.name; el('taskMode').value = task.mode; el('taskDuration').value = task.duration; el('taskCron').value = task.cron || '0 * * * *'; el('taskTimezone').value = task.timezone;
      el('taskMode').onchange(); el('saveTask').textContent = 'Save changes'; el('cancelEdit').hidden = false; el('taskForm').scrollIntoView({ behavior: 'smooth' }); return;
    }
    if (button.dataset.action === 'toggle') await request(`/api/tasks/${task.id}`, 'PATCH', { enabled: !task.enabled });
    if (button.dataset.action === 'run') await request(`/api/tasks/${task.id}/run`, 'POST', {});
    if (button.dataset.action === 'delete' && confirm('Delete this automation? Saved clips are kept.')) await request(`/api/tasks/${task.id}`, 'DELETE');
    await refresh();
  });
  el('recordingsList').addEventListener('click', action(async event => {
    const button = event.target.closest('[data-delete-record]');
    if (button && confirm('Permanently delete this clip?')) { await request(`/api/recordings/${button.dataset.deleteRecord}`, 'DELETE'); await loadRecordings(); }
  }));
  for (const key of ['search', 'mode', 'status', 'date']) el(`filter-${key}`).onchange = () => { window.libraryPage = 1; loadRecordings(); };
  el('previousPage').onclick = () => { window.libraryPage = Math.max(1, (window.libraryPage || 1) - 1); loadRecordings(); };
  el('nextPage').onclick = () => { window.libraryPage = Math.min(window.libraryPages || 1, (window.libraryPage || 1) + 1); loadRecordings(); };
  el('logout').hidden = !auth.required;
  el('logout').onclick = async () => { await request('/api/logout', 'POST', {}); location.reload(); };
  async function refresh() {
    const data = await request('/api/tasks'); tasks = data.tasks;
    el('taskSelection').textContent = editing ? 'Editing existing camera task' : state.camera ? `Selected: ${state.camera.name}` : 'Select a camera to create a task.';
    el('taskList').innerHTML = tasks.length ? tasks.map(task => `<div class="recording-row"><div class="recording-main"><strong>${escapeHtml(task.name)}</strong><span>${escapeHtml(task.roadName)} · ${escapeHtml(task.cameraName)}</span><span>${escapeHtml(task.mode)} · ${task.duration}s · ${escapeHtml(task.cron || 'Continuous')} · ${escapeHtml(task.timezone)}</span><span>${escapeHtml(task.status)} · Next: ${task.nextRun ? escapeHtml(new Date(task.nextRun).toLocaleString()) : 'when capacity is available'}${task.retryAt ? ` · Retry: ${escapeHtml(new Date(task.retryAt).toLocaleString())}` : ''}</span></div><div class="task-actions">${['toggle', 'run', 'edit', 'delete'].map(name => `<button class="button subtle-button" data-task="${task.id}" data-action="${name}">${name === 'toggle' ? task.enabled ? 'Pause' : 'Enable' : name === 'run' ? 'Run now' : name}</button>`).join('')}</div></div>`).join('') : '<div class="empty-state">No automation tasks yet.</div>';
    el('taskEvents').innerHTML = data.events.slice(0, 50).map(event => `<p>${escapeHtml(new Date(event.at).toLocaleString())} · ${escapeHtml(tasks.find(t => t.id === event.taskId)?.name || event.taskId)} · ${escapeHtml(event.message)}</p>`).join('') || '<p>No executions yet.</p>';
    const health = await request('/api/health');
    el('storageInfo').textContent = `Storage: ${bytesLabel(health.storage.recordingBytes)} saved · ${bytesLabel(health.storage.freeBytes)} free · ${health.active}/${health.maxActive} captures active. No automatic deletion.`;
    state.activeCount = health.active; renderRecordings();
  }
  await refresh(); setInterval(() => refresh().catch(error => showNotice(error.message)), 5000);
})().catch(error => { const notice = document.getElementById('notice'); notice.hidden = false; notice.textContent = error.message; });
