import React from 'react';

function LanUnavailable({ title = 'Esta pantalla' }) {
  return (
    <section className="lan-unavailable" role="status">
      <h2>{title}</h2>
      <p>Disponible cuando haya internet.</p>
    </section>
  );
}

export default LanUnavailable;
