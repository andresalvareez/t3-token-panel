// tokpanel v4: GET /api/tokpanel/agent-tree/<threadId> (contract-v4.md section 1). Inlined before UNTRACED_REQUEST_PATHS.
const tokpanelAgentTree = makeTokpanelAgentTree({ fsp: NodeFSP, path: NodePath, homedir, env: process.env });
// Every non-auth failure becomes HTTP 200 {ok:false,v:4,reason}; at most one warning per reason per minute (no paths/labels).
const tokpanelAgentTreeHandler = (sql, settingsService) => {
	const reply = (body) => jsonUnsafe(body, { status: 200, headers: { "cache-control": "no-store" } });
	const failure = (reason) => {
		const res = reply(tokpanelAgentTree.fail(reason));
		return tokpanelAgentTree.shouldLog(reason) ? logWarning("tokpanel agent-tree unavailable", { reason }).pipe(as(res)) : succeed(res);
	};
	const handle = (request) => gen(function* () {
		const threadId = tokpanelAgentTree.parseThreadId(request.url);
		if (threadId === null) return reply(tokpanelAgentTree.fail("bad-id"));
		const settings = yield* settingsService.getSettings.pipe(orElseSucceed(() => null));
		const plan = tokpanelAgentTree.queryPlan(threadId);
		let step = plan.next();
		while (!step.done) {
			const rows = yield* sql.unsafe(step.value.sql, step.value.params);
			step = plan.next(Array.from(rows));
		}
		const body = yield* tryPromise({ try: () => tokpanelAgentTree.run(threadId, step.value, settings), catch: () => "internal" });
		if (!body || (body.ok === false && body.reason === "internal")) return yield* failure("internal");
		return reply(body);
	});
	return (request) => suspend(() => handle(request)).pipe(catch_(() => failure("internal")), catchDefect(() => failure("internal")));
};
const layerTokpanelAgentTreeRoute = unwrap(gen(function* () {
	const handler = tokpanelAgentTreeHandler(yield* SqlClient, yield* ServerSettingsService);
	return add$2("GET", "/api/tokpanel/agent-tree/*", gen(function* () {
		yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
		return yield* handler(yield* HttpServerRequest);
	}).pipe(catchTags({
		EnvironmentAuthInvalidError: toResponse,
		EnvironmentInternalError: toResponse,
		EnvironmentScopeRequiredError: toResponse
	}), withTracerEnabled(false)));
}));
