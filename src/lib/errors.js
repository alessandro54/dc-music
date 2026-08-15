// An error whose message is written *for the user*, not for a log: a search that
// found nothing, a playlist Spotify won't hand over. It is a normal outcome of
// weird input, so `isNoise` in lib/sentry.js drops it before it ever becomes an
// issue, and the /play handler shows the message instead of a generic refusal.
//
// The rule of thumb: if the fix is "type something else", it's user-facing. If
// the fix is a code or config change, throw a plain Error.
export class UserFacingError extends Error {
    constructor(message) {
        super(message);
        this.name = "UserFacingError";
    }
}
