/**
 * ModuleRegistry — singleton registry for loaded module instances.
 *
 * Tracks all active modules by name. Names are unique — attempting to
 * register a duplicate throws ModuleConflictError.
 */

import { ModuleConflictError } from './errors.js';
import type { ModuleInstance } from './module-instance.js';

export class ModuleRegistry {
	private readonly modules = new Map<string, ModuleInstance>();

	/** Register a module. Throws ModuleConflictError if name already exists. */
	register(module: ModuleInstance): void {
		if (this.modules.has(module.name)) {
			throw new ModuleConflictError(module.name, `Module "${module.name}" is already loaded`);
		}
		this.modules.set(module.name, module);
	}

	/** Unregister a module by name. Returns the removed instance or undefined. */
	unregister(name: string): ModuleInstance | undefined {
		const module = this.modules.get(name);
		if (module) {
			this.modules.delete(name);
		}
		return module;
	}

	/** Get a module by name. */
	get(name: string): ModuleInstance | undefined {
		return this.modules.get(name);
	}

	/** Check if a module name is registered. */
	has(name: string): boolean {
		return this.modules.has(name);
	}

	/** List all registered modules. */
	list(): ModuleInstance[] {
		return [...this.modules.values()];
	}

	/** Get count of registered modules. */
	get size(): number {
		return this.modules.size;
	}
}
