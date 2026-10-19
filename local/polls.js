function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function action(label, callback) {
  const result = node('button', label);
  result.type = 'button';
  result.addEventListener('click', () => void callback());
  return result;
}

function optionLabel(option) {
  return option.label || option.text || option.id;
}

const locallyVotedPolls = new Set();

function hasVoted(sessionId, pollId) {
  const key = `agora-voted-${sessionId}-${pollId}`;
  if (locallyVotedPolls.has(key)) return true;
  try {
    return Boolean(sessionStorage.getItem(key));
  } catch {
    return false;
  }
}

function pollPath(sessionId, pollId = '') {
  const pollSuffix = pollId ? `/${encodeURIComponent(pollId)}` : '';
  return `/sessions/${encodeURIComponent(sessionId)}/polls${pollSuffix}`;
}

function results(poll) {
  const wrapper = node('div', undefined, 'poll-results');
  wrapper.append(
    node('p', `${poll.totalResponses} response${poll.totalResponses === 1 ? '' : 's'}`),
  );
  const total = Math.max(1, poll.totalResponses);
  for (const option of poll.options || []) {
    const count = poll.countsByOptionId?.[option.id] || 0;
    const percentage = Math.round((count / total) * 100);
    const row = node('div', undefined, 'poll-result');
    row.append(node('span', `${optionLabel(option)} — ${count} (${percentage}%)`));
    const track = node('div', undefined, 'poll-track');
    const fill = node('div', undefined, 'poll-fill');
    fill.style.width = `${percentage}%`;
    track.append(fill);
    row.append(track);
    wrapper.append(row);
  }
  return wrapper;
}

export function createPollComposer({
  sessionId,
  getSlideId,
  presenterToken,
  api,
  refresh,
  report,
}) {
  const section = node('section', undefined, 'card');
  section.append(node('h2', 'Create a poll for this slide'));
  const form = node('form');
  const questionLabel = node('label', 'Question');
  const question = node('input');
  question.required = true;
  questionLabel.append(question);

  const typeLabel = node('label', 'Poll type');
  const type = node('select');
  for (const [value, label] of [
    ['single-choice', 'Single choice'],
    ['multiple-choice', 'Multiple choice'],
    ['binary', 'Yes / No'],
  ]) {
    const option = node('option', label);
    option.value = value;
    type.append(option);
  }
  typeLabel.append(type);

  const optionsLabel = node('label', 'Choices (one per line)');
  const options = node('textarea');
  options.value = 'Option A\nOption B';
  optionsLabel.append(options);
  type.addEventListener('change', () => {
    const binary = type.value === 'binary';
    options.disabled = binary;
    if (binary) options.value = 'Yes\nNo';
  });

  const submit = node('button', 'Create closed poll');
  submit.type = 'submit';
  form.append(questionLabel, typeLabel, optionsLabel, submit);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const slideId = getSlideId();
      if (!slideId) throw new Error('Wait for an active slide before creating a poll.');
      const labels = options.value
        .split('\n')
        .map((value) => value.trim())
        .filter(Boolean);
      if (labels.length < 2) throw new Error('Add at least two choices.');
      submit.disabled = true;
      await api(pollPath(sessionId), {
        method: 'POST',
        headers: { 'x-presenter-token': presenterToken },
        body: JSON.stringify({
          slideId,
          question: question.value.trim(),
          type: type.value,
          options: labels.map((label, index) => ({ id: `option-${index + 1}`, label })),
          status: 'draft',
        }),
      });
      question.value = '';
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      submit.disabled = false;
    }
  });
  section.append(form);
  return section;
}

async function runPollAction(api, path, header, token, refresh, report) {
  try {
    await api(path, { method: 'POST', headers: { [header]: token } });
    await refresh();
  } catch (error) {
    report(error);
  }
}

function createPresenterControls(poll, sessionId, presenterToken, api, refresh, report) {
  const controls = node('div', undefined, 'row');
  const isOpen = poll.status === 'open';
  const basePath = pollPath(sessionId, poll.pollId);
  controls.append(
    action(isOpen ? 'Close voting' : 'Open voting', () =>
      runPollAction(
        api,
        `${basePath}/${isOpen ? 'close' : 'open'}`,
        'x-presenter-token',
        presenterToken,
        refresh,
        report,
      ),
    ),
  );
  if (poll.resultsRevealed) return controls;

  const reveal = action('Reveal on projector', () =>
    runPollAction(api, `${basePath}/reveal`, 'x-presenter-token', presenterToken, refresh, report),
  );
  reveal.disabled = isOpen;
  controls.append(reveal);
  return controls;
}

function createAudienceChoice(poll, option, choices, multiple) {
  const label = node('label', undefined, 'poll-choice');
  const input = node('input');
  input.type = multiple ? 'checkbox' : 'radio';
  input.name = `poll-${poll.pollId}`;
  input.value = option.id;
  input.checked = choices.has(option.id);
  input.addEventListener('change', () => {
    if (!multiple) choices.clear();
    if (input.checked) choices.add(option.id);
    else choices.delete(option.id);
  });
  label.append(input, document.createTextNode(optionLabel(option)));
  return label;
}

async function submitAudienceVote(
  event,
  poll,
  sessionId,
  participantToken,
  choices,
  submit,
  api,
  refresh,
  report,
) {
  event.preventDefault();
  try {
    if (!choices.size) throw new Error('Select at least one choice.');
    submit.disabled = true;
    await api(`${pollPath(sessionId, poll.pollId)}/vote`, {
      method: 'POST',
      headers: { 'x-participant-token': participantToken },
      body: JSON.stringify({ selectedOptionIds: [...choices] }),
    });
    const votedKey = `agora-voted-${sessionId}-${poll.pollId}`;
    locallyVotedPolls.add(votedKey);
    try {
      sessionStorage.setItem(votedKey, '1');
    } catch {
      // Keep the successful vote marked in memory when storage is unavailable.
    }
    await refresh();
  } catch (error) {
    report(error);
    submit.disabled = false;
  }
}

function createAudienceVoteForm(
  poll,
  sessionId,
  participantToken,
  selectedByPoll,
  api,
  refresh,
  report,
) {
  const form = node('form');
  const choices = selectedByPoll.get(poll.pollId) || new Set();
  selectedByPoll.set(poll.pollId, choices);
  const multiple = poll.type === 'multiple' || poll.type === 'multiple-choice';
  for (const option of poll.options || []) {
    form.append(createAudienceChoice(poll, option, choices, multiple));
  }
  const submit = node('button', 'Submit vote');
  submit.type = 'submit';
  form.append(submit);
  form.addEventListener(
    'submit',
    (event) =>
      void submitAudienceVote(
        event,
        poll,
        sessionId,
        participantToken,
        choices,
        submit,
        api,
        refresh,
        report,
      ),
  );
  return form;
}

function appendAudienceState(
  card,
  poll,
  sessionId,
  participantToken,
  selectedByPoll,
  api,
  refresh,
  report,
) {
  if (hasVoted(sessionId, poll.pollId)) {
    card.append(node('p', 'Your vote was recorded.', 'muted'));
  } else if (poll.status === 'open') {
    card.append(
      createAudienceVoteForm(
        poll,
        sessionId,
        participantToken,
        selectedByPoll,
        api,
        refresh,
        report,
      ),
    );
  } else {
    card.append(node('p', 'Voting is closed.', 'muted'));
  }
}

function createPollCard(poll, context) {
  const {
    role,
    sessionId,
    presenterToken,
    participantToken,
    selectedByPoll,
    api,
    refresh,
    report,
  } = context;
  const card = node('article', undefined, 'card poll-card');
  card.append(node('h3', poll.question || 'Poll'));
  const type = poll.type?.replaceAll('-', ' ') || 'single choice';
  card.append(node('p', `${type} · ${poll.status}`, 'muted'));

  if (role === 'presenter') {
    card.append(results(poll));
    card.append(createPresenterControls(poll, sessionId, presenterToken, api, refresh, report));
  } else if (poll.resultsRevealed) {
    card.append(results(poll));
  }
  if (role === 'audience') {
    appendAudienceState(
      card,
      poll,
      sessionId,
      participantToken,
      selectedByPoll,
      api,
      refresh,
      report,
    );
  }
  return card;
}

export function renderPolls(context) {
  const { polls, role } = context;
  const section = node('section', undefined, 'polls');
  section.append(node('h2', role === 'projector' ? 'Poll results' : 'Polls on this slide'));
  const visiblePolls = role === 'projector' ? polls.filter((poll) => poll.resultsRevealed) : polls;
  if (!visiblePolls.length) {
    const emptyMessage =
      role === 'projector' ? 'No results revealed yet.' : 'No polls on this slide yet.';
    section.append(node('p', emptyMessage, 'muted'));
    return section;
  }
  for (const poll of visiblePolls) section.append(createPollCard(poll, context));
  return section;
}
