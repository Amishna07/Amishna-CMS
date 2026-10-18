'use strict';

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const unavailable = () => new ApiError(503, 'DATABASE_UNAVAILABLE', 'The local database is unavailable. Check the backend data folder and try again.');
const conflict = currentRevision => new ApiError(409, 'REVISION_CONFLICT', 'This workspace changed in another session. Reload the saved workspace before trying again.', { currentRevision });
const tooLarge = () => new ApiError(413, 'WORKSPACE_TOO_LARGE', 'This workspace is too large to save. Reduce its size before trying again.');

module.exports = { ApiError, unavailable, conflict, tooLarge };
