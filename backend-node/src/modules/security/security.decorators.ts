import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_METADATA = 'publicRoute';
export const REQUIRED_SCOPES_METADATA = 'requiredScopes';
export const INTERNAL_ROUTE_METADATA = 'internalRoute';

export const PublicRoute = () => SetMetadata(PUBLIC_ROUTE_METADATA, true);
export const RequiredScopes = (...scopes: string[]) => SetMetadata(REQUIRED_SCOPES_METADATA, scopes);
export const InternalRoute = () => SetMetadata(INTERNAL_ROUTE_METADATA, true);
