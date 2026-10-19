export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    description: string;
  };
  servers: Array<{ url: string; description: string }>;
  tags: Array<{ name: string; description: string }>;
  paths: Record<string, Record<string, unknown>>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, unknown>;
  };
}

const ref = (schemaName: string) => ({ $ref: `#/components/schemas/${schemaName}` });

const jsonBody = (schema: Record<string, unknown>, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

const jsonRes = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: { 'application/json': { schema } },
});

const errRes = (description: string) => jsonRes(description, ref('ErrorResponse'));

const pathParam = (name: string, description: string) => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string' },
});

const adminSec = [{ AdminBearerAuth: [] }, { AdminHeaderToken: [] }];
const presenterSec = [
  { PresenterBearerAuth: [] },
  { PresenterHeaderToken: [] },
  { AdminBearerAuth: [] },
];
const participantSec = [{ ParticipantBearerAuth: [] }, { ParticipantHeaderToken: [] }];

export const AGORA_OPENAPI_SPEC: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Agora Interactive Conference Presentation API',
    version: '1.0.0',
    description:
      'OpenAPI 3.1.0 specification for Agora Cloudflare Worker, D1, R2, and Durable Object live session endpoints (SPEC-001 through SPEC-024).',
  },
  servers: [
    { url: 'http://localhost:8787', description: 'Local Cloudflare Emulation Environment' },
    { url: 'https://api.agora.live', description: 'Production Cloudflare Worker Edge' },
  ],
  tags: [
    { name: 'OpenAPI', description: 'API specification and interactive documentation' },
    {
      name: 'Presentations',
      description: 'Presentation administration, revisions, and R2/D1 assets (SPEC-001, SPEC-017)',
    },
    {
      name: 'Sessions',
      description:
        'Live presentation sessions, Durable Object SQLite state, and navigation (SPEC-002, SPEC-003, SPEC-022)',
    },
    {
      name: 'Questions',
      description: 'Slide-scoped Q&A and idempotent upvoting (SPEC-006, SPEC-007)',
    },
    {
      name: 'Interactions',
      description: 'Emoji reactions, contextual polls, adaptive navigation, and word clouds',
    },
    {
      name: 'Downloads',
      description: 'Gated R2 PNG and PDF asset downloads (SPEC-014, SPEC-016, SPEC-024)',
    },
  ],
  paths: {
    '/api/v1/openapi.json': {
      get: {
        tags: ['OpenAPI'],
        operationId: 'getOpenApiSpec',
        summary: 'Retrieve OpenAPI 3.1.0 JSON specification',
        responses: { '200': jsonRes('OpenAPI 3.1.0 specification document', { type: 'object' }) },
      },
    },
    '/api/v1/docs': {
      get: {
        tags: ['OpenAPI'],
        operationId: 'getOpenApiDocs',
        summary: 'Render interactive OpenAPI documentation UI',
        responses: {
          '200': {
            description: 'HTML documentation viewer',
            content: { 'text/html': { schema: { type: 'string' } } },
          },
        },
      },
    },
    '/api/v1/presentations': {
      get: {
        tags: ['Presentations'],
        operationId: 'listPresentations',
        summary: 'List all presentations',
        responses: {
          '200': jsonRes('Array of presentations', {
            type: 'array',
            items: ref('Presentation'),
          }),
        },
      },
      post: {
        tags: ['Presentations'],
        operationId: 'createPresentation',
        summary: 'Create a new presentation (SPEC-001)',
        security: adminSec,
        requestBody: jsonBody(ref('PresentationInput')),
        responses: {
          '201': jsonRes(
            'Created presentation with deterministic SHA-256 revisionHash',
            ref('Presentation'),
          ),
          '400': errRes('Validation error'),
          '401': errRes('Unauthorized admin'),
        },
      },
    },
    '/api/v1/presentations/{id}': {
      parameters: [pathParam('id', 'Presentation identifier')],
      get: {
        tags: ['Presentations'],
        operationId: 'getPresentation',
        summary: 'Get presentation by ID with slides and revision status',
        responses: {
          '200': jsonRes('Presentation details', ref('Presentation')),
          '404': errRes('Presentation not found'),
        },
      },
      put: {
        tags: ['Presentations'],
        operationId: 'replacePresentation',
        summary: 'Update presentation, bump revision, and purge stale assets (SPEC-001)',
        security: adminSec,
        requestBody: jsonBody(ref('PresentationInput')),
        responses: {
          '200': jsonRes('Updated presentation', ref('Presentation')),
          '400': errRes('Validation error'),
          '401': errRes('Unauthorized admin'),
          '404': errRes('Presentation not found'),
        },
      },
      patch: {
        tags: ['Presentations'],
        operationId: 'updatePresentation',
        summary: 'Partially update presentation, bump revision, and purge stale assets (SPEC-001)',
        security: adminSec,
        requestBody: jsonBody(ref('PresentationInput')),
        responses: {
          '200': jsonRes('Updated presentation', ref('Presentation')),
          '400': errRes('Validation error'),
          '401': errRes('Unauthorized admin'),
          '404': errRes('Presentation not found'),
        },
      },
      delete: {
        tags: ['Presentations'],
        operationId: 'deletePresentation',
        summary: 'Delete presentation (requires confirmDestroy confirmation)',
        security: adminSec,
        parameters: [
          {
            name: 'confirmDestroy',
            in: 'query',
            required: false,
            schema: { type: 'boolean' },
          },
        ],
        responses: {
          '200': jsonRes('Deletion confirmation', {
            type: 'object',
            properties: { ok: { type: 'boolean' }, deleted: { type: 'string' } },
          }),
          '400': errRes('Missing confirmDestroy confirmation'),
          '401': errRes('Unauthorized admin'),
          '404': errRes('Presentation not found'),
        },
      },
    },
    '/api/v1/presentations/{id}/duplicate': {
      parameters: [pathParam('id', 'Source presentation identifier')],
      post: {
        tags: ['Presentations'],
        operationId: 'duplicatePresentation',
        summary: 'Duplicate presentation without copying sessions or audience data (SPEC-017)',
        security: adminSec,
        requestBody: jsonBody({ type: 'object', properties: { title: { type: 'string' } } }, false),
        responses: {
          '201': jsonRes('Duplicated presentation', ref('Presentation')),
          '401': errRes('Unauthorized admin'),
          '404': errRes('Source presentation not found'),
        },
      },
    },
    '/api/v1/presentations/{id}/assets': {
      parameters: [pathParam('id', 'Presentation identifier')],
      post: {
        tags: ['Presentations'],
        operationId: 'uploadPresentationAsset',
        summary:
          'Upload slide PNG or deck PDF asset tied to presentation revision (SPEC-013, SPEC-015)',
        security: adminSec,
        responses: {
          '201': jsonRes('Registered asset manifest entry', ref('AssetManifestEntry')),
          '401': errRes('Unauthorized admin'),
          '404': errRes('Presentation not found'),
          '409': errRes('Revision mismatch conflict'),
        },
      },
    },
    '/api/v1/presentations/{id}/sessions': {
      parameters: [pathParam('id', 'Presentation identifier')],
      post: {
        tags: ['Sessions'],
        operationId: 'createSession',
        summary: 'Create a scheduled or live presentation session (SPEC-002)',
        security: adminSec,
        requestBody: jsonBody(
          {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['scheduled', 'live'] },
            },
          },
          false,
        ),
        responses: {
          '201': jsonRes(
            'Created session with presenterToken and QR code',
            ref('PresentationSession'),
          ),
          '401': errRes('Unauthorized admin'),
          '404': errRes('Presentation not found'),
        },
      },
    },
    '/api/v1/sessions/{id}': {
      parameters: [pathParam('id', 'Session identifier')],
      get: {
        tags: ['Sessions'],
        operationId: 'getAudienceSafeSession',
        summary: 'Fetch audience-safe session state (SPEC-002, SPEC-004, SPEC-005)',
        responses: {
          '200': jsonRes('Audience-safe session view', ref('AudienceSafeSessionView')),
          '404': errRes('Session not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/start': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Sessions'],
        operationId: 'startSession',
        summary: 'Transition a scheduled session to live status (SPEC-002)',
        security: presenterSec,
        responses: {
          '200': jsonRes('Live session state', ref('PresentationSession')),
          '400': errRes('Cannot start a completed session'),
          '403': errRes('Unauthorized presenter'),
          '404': errRes('Session not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/join': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Sessions'],
        operationId: 'joinSession',
        summary: 'Anonymous attendee join returning session-scoped participant token (SPEC-002)',
        requestBody: jsonBody(
          { type: 'object', properties: { displayName: { type: 'string' } } },
          false,
        ),
        responses: {
          '201': jsonRes('Issued participant identity and token', ref('ParticipantIdentity')),
          '400': errRes('Session already completed'),
          '404': errRes('Session not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/slide': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Sessions'],
        operationId: 'navigateSessionSlide',
        summary:
          'Navigate authoritative presenter slide and unlock PDF on ending slide (SPEC-003, SPEC-023)',
        security: presenterSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['slideId'],
          properties: { slideId: { type: 'string' } },
        }),
        responses: {
          '200': jsonRes('Updated session state', ref('PresentationSession')),
          '400': errRes('Missing or invalid slideId'),
          '403': errRes('Unauthorized presenter'),
          '404': errRes('Session not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/complete': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Sessions'],
        operationId: 'completeSession',
        summary: 'Explicitly mark session as completed (SPEC-002, SPEC-022)',
        security: presenterSec,
        responses: {
          '200': jsonRes('Completed session state', ref('PresentationSession')),
          '403': errRes('Unauthorized presenter'),
          '404': errRes('Session not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/slides/{slideId}': {
      parameters: [pathParam('id', 'Session identifier'), pathParam('slideId', 'Slide identifier')],
      get: {
        tags: ['Sessions'],
        operationId: 'getRevealedSlideMetadata',
        summary: 'Fetch metadata for a revealed slide (SPEC-005)',
        responses: {
          '200': jsonRes('Revealed slide metadata', ref('SlideMetadata')),
          '403': errRes('Slide has not been revealed yet'),
          '404': errRes('Session or slide not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/questions': {
      parameters: [pathParam('id', 'Session identifier')],
      get: {
        tags: ['Questions'],
        operationId: 'listSessionQuestions',
        summary: 'List questions for session (optionally filtered by slideId)',
        parameters: [{ name: 'slideId', in: 'query', required: false, schema: { type: 'string' } }],
        responses: {
          '200': jsonRes('Questions list', { type: 'array', items: ref('AudienceQuestion') }),
        },
      },
      post: {
        tags: ['Questions'],
        operationId: 'submitQuestion',
        summary: 'Submit a slide-scoped audience question (SPEC-006)',
        security: participantSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['slideId', 'content'],
          properties: {
            slideId: { type: 'string' },
            content: { type: 'string' },
            participantName: { type: 'string' },
          },
        }),
        responses: {
          '201': jsonRes('Created question', ref('AudienceQuestion')),
          '400': errRes('Invalid question content'),
          '401': errRes('Unauthorized participant'),
          '403': errRes('Slide not revealed'),
          '429': errRes('Rate limit exceeded'),
        },
      },
    },
    '/api/v1/sessions/{id}/questions/{questionId}/upvote': {
      parameters: [
        pathParam('id', 'Session identifier'),
        pathParam('questionId', 'Question identifier'),
      ],
      post: {
        tags: ['Questions'],
        operationId: 'toggleQuestionUpvote',
        summary: 'Idempotently toggle participant upvote on a question (SPEC-007)',
        security: participantSec,
        responses: {
          '200': jsonRes('Updated question upvote count', ref('AudienceQuestion')),
          '401': errRes('Unauthorized participant'),
          '404': errRes('Question not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/questions/{questionId}': {
      parameters: [
        pathParam('id', 'Session identifier'),
        pathParam('questionId', 'Question identifier'),
      ],
      patch: {
        tags: ['Questions'],
        operationId: 'updateQuestionStatus',
        summary: 'Update question status to pending, answered, or dismissed (SPEC-006)',
        security: presenterSec,
        requestBody: jsonBody({
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['pending', 'answered', 'dismissed'] },
          },
        }),
        responses: {
          '200': jsonRes('Updated question', ref('AudienceQuestion')),
          '403': errRes('Unauthorized presenter'),
          '404': errRes('Question not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/reactions': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Interactions'],
        operationId: 'submitReaction',
        summary: 'Submit emoji reaction for a revealed slide (SPEC-009)',
        security: participantSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['slideId', 'reaction'],
          properties: {
            slideId: { type: 'string' },
            reaction: { type: 'string', enum: ['👍', '🤔', '❤️', '😴'] },
          },
        }),
        responses: {
          '200': jsonRes('Updated reaction summary', {
            type: 'object',
            properties: { ok: { type: 'boolean' }, summary: ref('ReactionCounts') },
          }),
          '400': errRes('Invalid reaction'),
          '401': errRes('Unauthorized participant'),
          '403': errRes('Slide not revealed'),
          '429': errRes('Rate limit exceeded'),
        },
      },
    },
    '/api/v1/sessions/{id}/polls': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Interactions'],
        operationId: 'createPoll',
        summary: 'Create and open a contextual slide poll (SPEC-010)',
        security: presenterSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['slideId', 'question', 'options'],
          properties: {
            slideId: { type: 'string' },
            question: { type: 'string' },
            type: { type: 'string', enum: ['single', 'multiple', 'binary'] },
            options: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'label'],
                properties: { id: { type: 'string' }, label: { type: 'string' } },
              },
            },
          },
        }),
        responses: {
          '201': jsonRes('Created poll', ref('PollDefinition')),
          '400': errRes('Invalid poll definition'),
          '403': errRes('Unauthorized presenter'),
        },
      },
    },
    '/api/v1/sessions/{id}/polls/{pollId}/vote': {
      parameters: [pathParam('id', 'Session identifier'), pathParam('pollId', 'Poll identifier')],
      post: {
        tags: ['Interactions'],
        operationId: 'votePoll',
        summary:
          'Submit participant vote in poll and evaluate adaptive navigation (SPEC-010, SPEC-011)',
        security: participantSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['optionId'],
          properties: { optionId: { type: 'string' } },
        }),
        responses: {
          '200': jsonRes('Poll results summary and navigation suggestions', {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              summary: ref('PollResultsSummary'),
              suggestions: { type: 'array', items: { type: 'object' } },
            },
          }),
          '400': errRes('Invalid option or closed poll'),
          '401': errRes('Unauthorized participant'),
          '409': errRes('Participant already voted'),
        },
      },
    },
    '/api/v1/sessions/{id}/wordclouds': {
      parameters: [pathParam('id', 'Session identifier')],
      post: {
        tags: ['Interactions'],
        operationId: 'createWordCloud',
        summary: 'Create and open a word cloud prompt (SPEC-021)',
        security: presenterSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['slideId', 'prompt'],
          properties: { slideId: { type: 'string' }, prompt: { type: 'string' } },
        }),
        responses: {
          '201': jsonRes('Created word cloud prompt', ref('WordCloudPrompt')),
          '400': errRes('Invalid prompt'),
          '403': errRes('Unauthorized presenter'),
        },
      },
    },
    '/api/v1/sessions/{id}/wordclouds/{promptId}/submit': {
      parameters: [
        pathParam('id', 'Session identifier'),
        pathParam('promptId', 'Word cloud prompt identifier'),
      ],
      post: {
        tags: ['Interactions'],
        operationId: 'submitWordCloudTerm',
        summary: 'Submit normalized term to word cloud (SPEC-021)',
        security: participantSec,
        requestBody: jsonBody({
          type: 'object',
          required: ['term'],
          properties: { term: { type: 'string' } },
        }),
        responses: {
          '200': jsonRes('Updated word cloud aggregate', ref('WordCloudAggregate')),
          '400': errRes('Invalid or closed prompt'),
          '401': errRes('Unauthorized participant'),
          '429': errRes('Rate limit exceeded'),
        },
      },
    },
    '/api/v1/sessions/{id}/slides/{slideId}/download': {
      parameters: [pathParam('id', 'Session identifier'), pathParam('slideId', 'Slide identifier')],
      get: {
        tags: ['Downloads'],
        operationId: 'downloadSlidePng',
        summary: 'Download gated single-slide PNG if slide is revealed (SPEC-014, SPEC-024)',
        responses: {
          '200': {
            description: 'PNG slide image binary stream',
            content: { 'image/png': { schema: { type: 'string', format: 'binary' } } },
          },
          '403': errRes('Slide has not been revealed yet'),
          '404': errRes('Session or current-revision PNG not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/download': {
      parameters: [pathParam('id', 'Session identifier')],
      get: {
        tags: ['Downloads'],
        operationId: 'downloadPresentationPdf',
        summary:
          'Download gated full presentation PDF after ending slide visit (SPEC-016, SPEC-024)',
        responses: {
          '200': {
            description: 'PDF presentation binary stream',
            content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
          },
          '403': errRes('PDF download is locked until ending slide is reached'),
          '404': errRes('Session or current-revision PDF not found'),
        },
      },
    },
    '/api/v1/sessions/{id}/ws': {
      parameters: [pathParam('id', 'Session identifier')],
      get: {
        tags: ['Sessions'],
        operationId: 'connectSessionWebSocket',
        summary:
          'Upgrade connection to WebSocket real-time session stream and restore state (SPEC-002, SPEC-019)',
        responses: {
          '101': { description: 'Switching Protocols — WebSocket connection established' },
          '200': { description: 'WebSocket endpoint ready' },
          '403': errRes('Origin not allowed'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      AdminBearerAuth: { type: 'http', scheme: 'bearer', description: 'Admin secret bearer token' },
      AdminHeaderToken: { type: 'apiKey', in: 'header', name: 'x-admin-token' },
      PresenterBearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Session-scoped presenter token',
      },
      PresenterHeaderToken: { type: 'apiKey', in: 'header', name: 'x-presenter-token' },
      ParticipantBearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Session-scoped pseudonymous participant token',
      },
      ParticipantHeaderToken: { type: 'apiKey', in: 'header', name: 'x-participant-token' },
    },
    schemas: {
      ErrorResponse: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' } },
      },
      SlideMetadata: {
        type: 'object',
        required: ['id', 'presentationId', 'title', 'horizontalIndex', 'verticalIndex', 'order'],
        properties: {
          id: { type: 'string' },
          presentationId: { type: 'string' },
          title: { type: 'string' },
          horizontalIndex: { type: 'integer' },
          verticalIndex: { type: 'integer' },
          order: { type: 'integer' },
          isQaSlide: { type: 'boolean' },
        },
      },
      PresentationInput: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          eventName: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'published'] },
          endingSlideId: { type: 'string' },
          branding: {
            type: 'object',
            properties: {
              colors: { type: 'object', additionalProperties: { type: 'string' } },
              logoAssetId: { type: 'string' },
            },
          },
          slides: { type: 'array', items: ref('SlideMetadata') },
        },
      },
      Presentation: {
        type: 'object',
        required: ['id', 'title', 'revision', 'status', 'endingSlideId', 'branding'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          eventName: { type: 'string' },
          revision: { type: 'string' },
          revisionHash: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'published'] },
          endingSlideId: { type: 'string' },
          branding: { type: 'object' },
          slides: { type: 'array', items: ref('SlideMetadata') },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      AssetManifestEntry: {
        type: 'object',
        required: [
          'assetId',
          'presentationId',
          'revision',
          'kind',
          'r2Key',
          'contentType',
          'byteSize',
        ],
        properties: {
          assetId: { type: 'string' },
          presentationId: { type: 'string' },
          revision: { type: 'string' },
          kind: { type: 'string', enum: ['slide-png', 'deck-pdf', 'logo'] },
          slideId: { type: 'string' },
          r2Key: { type: 'string' },
          contentType: { type: 'string' },
          byteSize: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      PresentationSession: {
        type: 'object',
        required: [
          'id',
          'presentationId',
          'presentationRevision',
          'status',
          'revealedSlideIds',
          'pdfDownloadUnlocked',
        ],
        properties: {
          id: { type: 'string' },
          presentationId: { type: 'string' },
          presentationRevision: { type: 'string' },
          status: { type: 'string', enum: ['scheduled', 'live', 'completed'] },
          currentSlideId: { type: ['string', 'null'] },
          revealedSlideIds: { type: 'array', items: { type: 'string' } },
          pdfDownloadUnlocked: { type: 'boolean' },
          audienceUrl: { type: 'string' },
          qrCodeDataUrl: { type: 'string' },
          connectedParticipants: { type: 'integer' },
          startedAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time' },
        },
      },
      ParticipantIdentity: {
        type: 'object',
        required: ['id', 'sessionId', 'token', 'joinedAt'],
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          token: { type: 'string' },
          displayName: { type: 'string' },
          joinedAt: { type: 'string', format: 'date-time' },
        },
      },
      AudienceQuestion: {
        type: 'object',
        required: ['id', 'sessionId', 'slideId', 'participantId', 'content', 'status', 'upvotes'],
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          slideId: { type: 'string' },
          participantId: { type: 'string' },
          participantName: { type: 'string' },
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'answered', 'dismissed'] },
          upvotes: { type: 'integer' },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      PollDefinition: {
        type: 'object',
        required: ['id', 'sessionId', 'slideId', 'question', 'type', 'options', 'status'],
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          slideId: { type: 'string' },
          question: { type: 'string' },
          type: { type: 'string', enum: ['single', 'multiple', 'binary'] },
          options: { type: 'array', items: { type: 'object' } },
          status: { type: 'string', enum: ['draft', 'open', 'closed'] },
          resultsRevealed: { type: 'boolean' },
        },
      },
      PollResultsSummary: {
        type: 'object',
        required: ['pollId', 'slideId', 'status', 'totalResponses', 'countsByOptionId'],
        properties: {
          pollId: { type: 'string' },
          slideId: { type: 'string' },
          status: { type: 'string' },
          resultsRevealed: { type: 'boolean' },
          totalResponses: { type: 'integer' },
          countsByOptionId: { type: 'object', additionalProperties: { type: 'integer' } },
        },
      },
      WordCloudPrompt: {
        type: 'object',
        required: ['id', 'sessionId', 'slideId', 'prompt', 'status'],
        properties: {
          id: { type: 'string' },
          sessionId: { type: 'string' },
          slideId: { type: 'string' },
          prompt: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'open', 'closed'] },
        },
      },
      WordCloudAggregate: {
        type: 'object',
        required: ['promptId', 'slideId', 'status', 'totalSubmissions', 'terms'],
        properties: {
          promptId: { type: 'string' },
          slideId: { type: 'string' },
          status: { type: 'string' },
          totalSubmissions: { type: 'integer' },
          terms: {
            type: 'array',
            items: {
              type: 'object',
              properties: { term: { type: 'string' }, count: { type: 'integer' } },
            },
          },
        },
      },
      ReactionCounts: {
        type: 'object',
        properties: {
          '👍': { type: 'integer' },
          '🤔': { type: 'integer' },
          '❤️': { type: 'integer' },
          '😴': { type: 'integer' },
        },
      },
      AudienceSafeSessionView: {
        type: 'object',
        required: [
          'session',
          'slides',
          'availablePngSlideIds',
          'pdfAvailable',
          'questions',
          'activePolls',
          'activeWordClouds',
          'reactionSummary',
        ],
        properties: {
          session: ref('PresentationSession'),
          slides: { type: 'array', items: ref('SlideMetadata') },
          availablePngSlideIds: { type: 'array', items: { type: 'string' } },
          pdfAvailable: { type: 'boolean' },
          questions: { type: 'array', items: ref('AudienceQuestion') },
          activePolls: { type: 'array', items: ref('PollResultsSummary') },
          activeWordClouds: { type: 'array', items: ref('WordCloudAggregate') },
          reactionSummary: { type: 'object', additionalProperties: ref('ReactionCounts') },
        },
      },
    },
  },
};

export function renderOpenApiDocsHtml(specUrl = '/api/v1/openapi.json'): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${AGORA_OPENAPI_SPEC.info.title} — OpenAPI 3.1 Docs</title>
</head>
<body>
  <script id="api-reference" data-url="${specUrl}"></script>
  <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
</body>
</html>`;
}
