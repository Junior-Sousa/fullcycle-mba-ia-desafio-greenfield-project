import { DomainException } from '../../common/exceptions/domain.exception';

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoNotOwnedByUserException extends DomainException {
  constructor() {
    super('VIDEO_NOT_OWNED_BY_USER', 403, 'You do not own this video');
  }
}

export class InvalidVideoStateException extends DomainException {
  constructor(message = 'Invalid video state transition') {
    super('INVALID_VIDEO_STATE', 400, message);
  }
}
