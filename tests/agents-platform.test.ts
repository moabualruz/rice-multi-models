import { expect, test } from 'bun:test'
import { pluginRoot } from '../hooks/agents.ts'

test('plugin agent files resolve Windows drive and UNC installs with matching project boundaries', () => {
  const plugins = { 'example@marketplace': [
    { scope: 'user', installPath: 'C:\\Users\\name\\plugin' },
    { scope: 'project', projectPath: 'C:\\Work\\Project', installPath: '\\\\host\\share\\project plugin\\' },
  ] }
  expect(pluginRoot(plugins, 'example', 'c:/work/project/src')).toEqual({ root: '\\\\host\\share\\project plugin' })
  expect(pluginRoot(plugins, 'example', 'C:\\Work\\Project-other')).toEqual({ root: 'C:\\Users\\name\\plugin' })
  expect(pluginRoot({ 'example@marketplace': [{ installPath: 'C:relative' }] }, 'example', 'C:\\Work')).toHaveProperty('error')
})

test('POSIX plugin project matching remains case-sensitive', () => {
  const plugins = { 'example@marketplace': [{ installPath: '/user/plugin' }, { projectPath: '/Work/Project', installPath: '/project/plugin' }] }
  expect(pluginRoot(plugins, 'example', '/Work/Project/src')).toEqual({ root: '/project/plugin' })
  expect(pluginRoot(plugins, 'example', '/work/project/src')).toEqual({ root: '/user/plugin' })
})
