import starlight from '@astrojs/starlight';
// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: 'https://orgloop.ai',
	integrations: [
		starlight({
			title: 'OrgLoop',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/c-h-/orgloop' }],
			sidebar: [
				{
					label: 'Start',
					items: [
						{ label: 'What is OrgLoop?', slug: 'start/what-is-orgloop' },
						{ label: 'Getting Started', slug: 'start/getting-started' },
						{ label: 'User Guide', slug: 'start/user-guide' },
					],
				},
				{
					label: 'Concepts',
					items: [
						{ label: 'Five Primitives', slug: 'concepts/five-primitives' },
						{ label: 'Event Taxonomy', slug: 'concepts/event-taxonomy' },
						{ label: 'Projects', slug: 'concepts/projects' },
						{ label: 'Architecture', slug: 'concepts/architecture' },
					],
				},
				{
					label: 'CLI',
					items: [{ label: 'Command Reference', slug: 'cli/command-reference' }],
				},
				{
					label: 'Guides',
					items: [
						{ label: 'Building Connectors', slug: 'guides/connector-authoring' },
						{ label: 'Building Transforms', slug: 'guides/transform-authoring' },
						{ label: 'Project Setup', slug: 'guides/project-setup' },
						{ label: 'Security', slug: 'guides/security' },
						{ label: 'Contributing', slug: 'guides/contributing' },
					],
				},
				{
					label: 'Examples',
					items: [
						{ label: 'Minimal (Start Here)', slug: 'examples/minimal' },
						{ label: 'GitHub to Slack', slug: 'examples/github-to-slack' },
						{ label: 'Engineering Org', slug: 'examples/engineering-org' },
						{ label: 'Multi-Agent Supervisor', slug: 'examples/multi-agent-supervisor' },
						{ label: 'Beyond Engineering', slug: 'examples/beyond-engineering' },
						{ label: 'Org-to-Org', slug: 'examples/org-to-org' },
					],
				},
				{
					label: 'Reference',
					items: [
						{ label: 'Event Schema', slug: 'reference/event-schema' },
						{ label: 'Config Schema', slug: 'reference/config-schema' },
						{ label: 'Glossary', slug: 'reference/glossary' },
					],
				},
				{
					label: 'Specification',
					items: [
						{ label: 'Overview', slug: 'spec' },
						{ label: 'Repository Organization', slug: 'spec/repo-organization' },
						{ label: 'Config & Schema', slug: 'spec/config-schema' },
						{ label: 'Tech Stack', slug: 'spec/tech-stack' },
						{ label: 'Scale Design', slug: 'spec/scale-design' },
						{ label: 'Validation Plan', slug: 'spec/validation-plan' },
						{ label: 'Plugin System', slug: 'spec/plugin-system' },
						{ label: 'CLI Design', slug: 'spec/cli-design' },
						{ label: 'Runtime Modes', slug: 'spec/runtime-modes' },
						{ label: 'Transforms', slug: 'spec/transforms' },
						{ label: 'Loggers', slug: 'spec/loggers' },
						{ label: 'Project Model', slug: 'spec/modules' },
						{ label: 'Runtime Lifecycle', slug: 'spec/runtime-lifecycle' },
						{ label: 'Roadmap', slug: 'spec/roadmap' },
						{ label: 'Scope Boundaries', slug: 'spec/scope-boundaries' },
						{ label: 'Event Schema', slug: 'spec/event-schema' },
						{ label: 'Glossary', slug: 'spec/glossary' },
						{ label: 'Open Decisions', slug: 'spec/open-decisions' },
						{ label: 'Future Extensions', slug: 'spec/future-extensions' },
					],
				},
				{
					label: 'Vision',
					items: [
						{ label: 'Manifesto', slug: 'vision/manifesto' },
						{ label: 'Scope & Boundaries', slug: 'vision/scope-boundaries' },
						{ label: 'orgctl', slug: 'vision/orgctl' },
						{ label: 'agentctl', slug: 'vision/agentctl' },
					],
				},
			],
		}),
	],
});
