import { createPollComposer, renderPolls } from './polls.js';

const app = document.querySelector('#app');
const params = new URLSearchParams(location.search);
const sessionId = params.get('session');
const role = params.get('role') || 'admin';
const tokenKey = 'agora-local-admin-token';
const sessionsKey = 'agora-local-sessions';

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(label, action) {
  const node = element('button', label);
  node.addEventListener('click', () => void action());
  return node;
}

function card(title) {
  const node = element('section', undefined, 'card');
  node.append(element('h2', title));
  return node;
}

function field(parent, label, value = '', multiline = false) {
  const wrapper = element('label', label);
  const input = element(multiline ? 'textarea' : 'input');
  input.value = value;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}

function link(label, id, targetRole) {
  const node = element('a', label);
  node.href = `/?session=${encodeURIComponent(id)}&role=${targetRole}`;
  return node;
}

function report(error) {
  const message = element('p', error instanceof Error ? error.message : String(error), 'error');
  app.prepend(message);
}

async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
  return result;
}

function savedSessions() {
  try {
    return JSON.parse(localStorage.getItem(sessionsKey) || '{}');
  } catch {
    return {};
  }
}

async function showAdmin() {
  app.replaceChildren();
  const auth = card('Local admin access');
  const token = field(
    auth,
    'Admin token',
    sessionStorage.getItem(tokenKey) || 'agora-admin-secret-token',
  );
  token.addEventListener('change', () => sessionStorage.setItem(tokenKey, token.value));
  app.append(auth);

  const form = card('Create a presentation');
  const title = field(form, 'Title', 'My presentation');
  const slidesText = field(
    form,
    'Slide titles (one per line)',
    'Welcome\nMain idea\nQuestions',
    true,
  );
  form.append(
    button('Create presentation', async () => {
      try {
        sessionStorage.setItem(tokenKey, token.value);
        const titles = slidesText.value
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!titles.length) throw new Error('Add at least one slide title.');
        const slides = titles.map((name, index) => ({
          id: `slide-${index + 1}`,
          title: name,
          horizontalIndex: index,
          verticalIndex: 0,
          order: index,
        }));
        await api('/presentations', {
          method: 'POST',
          headers: { 'x-admin-token': token.value },
          body: JSON.stringify({ title: title.value, slides, endingSlideId: slides.at(-1).id }),
        });
        await showAdmin();
      } catch (error) {
        report(error);
      }
    }),
  );
  app.append(form);

  const list = card('Presentations');
  app.append(list);
  try {
    const presentations = await api('/presentations');
    if (!presentations.length) list.append(element('p', 'No presentations yet.', 'muted'));
    for (const presentation of presentations) {
      const item = element('div', undefined, 'card');
      item.append(
        element('h3', presentation.title),
        element('p', `${presentation.slides?.length || 0} slides`, 'muted'),
      );
      item.append(
        button('Start live session', async () => {
          try {
            const session = await api(
              `/presentations/${encodeURIComponent(presentation.id)}/sessions`,
              { method: 'POST', headers: { 'x-admin-token': token.value }, body: '{}' },
            );
            const saved = savedSessions();
            saved[session.id] = {
              presenterToken: session.presenterToken,
              title: presentation.title,
            };
            localStorage.setItem(sessionsKey, JSON.stringify(saved));
            location.href = link('', session.id, 'presenter').href;
          } catch (error) {
            report(error);
          }
        }),
      );
      list.append(item);
    }
  } catch (error) {
    report(error);
  }
  const sessions = Object.entries(savedSessions());
  if (sessions.length) {
    const recent = card('Sessions from this browser');
    for (const [id, session] of sessions) {
      const row = element('p');
      row.append(
        element('strong', `${session.title}: `),
        link('Presenter', id, 'presenter'),
        document.createTextNode(' · '),
        link('Audience', id, 'audience'),
      );
      recent.append(row);
    }
    app.append(recent);
  }
}

async function showSession() {
  app.replaceChildren();
  if (role !== 'projector') {
    const nav = element('p');
    nav.append(link('← Presentations', '', 'admin'));
    app.append(nav);
  }
  const panel = card(
    role === 'projector' ? 'Projector' : role === 'presenter' ? 'Presenter' : 'Audience',
  );
  app.append(panel);
  const participantToken = sessionStorage.getItem(`agora-participant-${sessionId}`);
  if (role === 'audience' && !participantToken) {
    const name = field(panel, 'Your name (optional)');
    panel.append(
      button('Join session', async () => {
        try {
          const participant = await api(`/sessions/${encodeURIComponent(sessionId)}/join`, {
            method: 'POST',
            body: JSON.stringify({ displayName: name.value }),
          });
          sessionStorage.setItem(`agora-participant-${sessionId}`, participant.token);
          await showSession();
        } catch (error) {
          report(error);
        }
      }),
    );
    return;
  }
  const token = savedSessions()[sessionId]?.presenterToken;
  if (role === 'presenter' && !token) {
    panel.append(
      element(
        'p',
        'Open this session from the browser where it was created, or enter its presenter token.',
      ),
    );
    const tokenInput = field(panel, 'Presenter token');
    panel.append(
      button('Use token', () => {
        const saved = savedSessions();
        saved[sessionId] = { presenterToken: tokenInput.value, title: 'Presentation' };
        localStorage.setItem(sessionsKey, JSON.stringify(saved));
        void showSession();
      }),
    );
    return;
  }
  const view = element('div');
  panel.append(view);
  let currentSlideId = null;
  const selectedByPoll = new Map();
  if (role === 'presenter') {
    panel.append(
      createPollComposer({
        sessionId,
        getSlideId: () => currentSlideId,
        presenterToken: token,
        api,
        refresh,
        report,
      }),
    );
  }
  let refreshing = false;
  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const data = await api(
        `/sessions/${encodeURIComponent(sessionId)}`,
        role === 'presenter' ? { headers: { 'x-presenter-token': token } } : {},
      );
      const { session, slides, activePolls } = data;
      currentSlideId = session.currentSlideId;
      const index = slides.findIndex((slide) => slide.id === session.currentSlideId);
      view.replaceChildren();
      if (role !== 'projector') {
        view.append(
          element(
            'p',
            `Session: ${session.status} · ${session.connectedParticipants || 0} participants`,
            'muted',
          ),
        );
      }
      view.append(element('div', slides[index]?.title || 'Waiting for presenter', 'slide'));
      view.append(element('p', `Slide ${Math.max(0, index + 1)} of ${slides.length}`));
      const slidePolls = activePolls.filter((poll) => poll.slideId === currentSlideId);
      view.append(
        renderPolls({
          polls: slidePolls,
          role,
          sessionId,
          presenterToken: token,
          participantToken,
          selectedByPoll,
          api,
          refresh,
          report,
        }),
      );
      if (role === 'presenter') {
        const controls = element('div', undefined, 'row');
        for (const [label, nextIndex] of [
          ['Previous', index - 1],
          ['Next', index + 1],
        ]) {
          const control = button(label, async () => {
            try {
              const slide = slides[nextIndex];
              await api(`/sessions/${encodeURIComponent(sessionId)}/slide`, {
                method: 'POST',
                headers: { 'x-presenter-token': token },
                body: JSON.stringify({
                  slideId: slide.id,
                  horizontalIndex: slide.horizontalIndex,
                  verticalIndex: slide.verticalIndex,
                }),
              });
              await refresh();
            } catch (error) {
              report(error);
            }
          });
          control.disabled = !slides[nextIndex] || session.status !== 'live';
          controls.append(control);
        }
        controls.append(link('Open audience view', sessionId, 'audience'));
        controls.append(link('Open projector view', sessionId, 'projector'));
        view.append(controls);
      }
    } catch (error) {
      report(error);
    } finally {
      refreshing = false;
    }
  }
  await refresh();
  setInterval(() => void refresh(), 1500);
  const socketUrl = new URL(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/ws`,
    location.origin,
  );
  socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socketToken = role === 'presenter' ? token : participantToken;
  if (socketToken) socketUrl.searchParams.set('token', socketToken);
  const socket = new WebSocket(socketUrl);
  socket.addEventListener('message', () => void refresh());
}

if (sessionId && role !== 'admin') await showSession();
else await showAdmin();
