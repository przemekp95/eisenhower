import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ContractMethod } from './types';

const ROUTE_FILES: Record<string, string> = {
  'health.ts': '/health',
  'tasks.ts': '/tasks',
  'calendar.ts': '/calendar',
  'googleOAuth.ts': '/calendar/oauth',
  'calendarInternal.ts': '/internal/calendar',
  'googleCalendarProvider.ts': '/internal/calendar/provider',
};

export function extractExpressRoutes(repositoryRoot: string): string[] {
  const routesDirectory = path.join(repositoryRoot, 'src', 'routes');
  const routes: string[] = [];
  for (const [filename, mountPath] of Object.entries(ROUTE_FILES)) {
    const sourceText = fs.readFileSync(path.join(routesDirectory, filename), 'utf8');
    const source = ts.createSourceFile(filename, sourceText, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const owner = node.expression.expression;
        const method = node.expression.name.text.toUpperCase();
        const route = node.arguments[0];
        if (
          ts.isIdentifier(owner)
          && owner.text === 'router'
          && ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'DELETE'].includes(method)
          && route
          && ts.isStringLiteral(route)
        ) {
          const suffix = route.text === '/' ? '' : route.text;
          routes.push(`${method as ContractMethod} ${mountPath}${suffix}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return routes.sort();
}
