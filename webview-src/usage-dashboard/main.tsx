import { render } from 'preact';
import { App } from './src/app';
import './src/styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Usage dashboard root element not found.');
}

render(<App />, root);
